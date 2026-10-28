import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { RuntimeFailure, object, type RetrieveParams, type SearchParams, type ToolName, type WorkerTransport,type ScientificParams } from "./contracts.ts";

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}
export interface WorkerOptions {
  pythonPath: string;
  workerPath: string;
  corpusDir: string;
  timeoutMs?: number;
  maxFrameBytes?: number;
  profile?: string;
  indexDir?: string;
  modelsDir?: string;
  device?: "cuda" | "cpu";
  expectReady?: boolean;
  readyTimeoutMs?: number;
  scientificCacheDir?:string;
  memoryDir?:string;
}
export interface WorkerReady { version: 1; type: "ready"; backend: string; index_version: string }

/** Only OS execution variables reach the corpus worker; provider credentials never do. */
export function workerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
  for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

export class PythonWorkerClient implements WorkerTransport {
  readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private readonly timeoutMs: number;
  private readonly maxFrameBytes: number;
  private buffer = "";
  private failure: RuntimeFailure | undefined;
  private readonly readiness: Promise<WorkerReady | undefined>;
  private readyPending: { resolve(value: WorkerReady): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | undefined;
  private readonly expectReady: boolean;
  private readyReceived = false;

  constructor(options: WorkerOptions) {
    for (const path of [options.pythonPath, options.workerPath, options.corpusDir, options.indexDir, options.modelsDir,options.scientificCacheDir,options.memoryDir].filter((path): path is string => path !== undefined)) {
      if (!isAbsolute(path)) throw new RuntimeFailure("INVALID_CONFIG", "Worker paths must be absolute");
    }
    this.expectReady = options.expectReady ?? false;
    this.timeoutMs = options.timeoutMs ?? (this.expectReady ? 60_000 : 15_000);
    this.maxFrameBytes = options.maxFrameBytes ?? 1_048_576;
    const args = [options.workerPath, "--corpus-dir", options.corpusDir,
      ...(options.profile ? ["--profile", options.profile] : []), ...(options.indexDir ? ["--index-dir", options.indexDir] : []),
      ...(options.modelsDir ? ["--models-dir", options.modelsDir] : []), ...(options.device ? ["--device", options.device] : []),...(options.scientificCacheDir?["--scientific-cache-dir",options.scientificCacheDir]:[]),...(options.memoryDir?['--memory-dir',options.memoryDir]:[])];
    this.readiness = this.expectReady ? new Promise<WorkerReady>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new RuntimeFailure("WORKER_READY_TIMEOUT", "Corpus worker did not become ready in time")); this.process.kill();
      }, options.readyTimeoutMs ?? 180_000);
      this.readyPending = { resolve, reject, timer };
    }) : Promise.resolve(undefined);
    // Keep preflight failures handled even before the caller awaits readiness.
    void this.readiness.catch(() => {});
    this.process = spawn(options.pythonPath, args, {
      shell: false, windowsHide: true, env: {...workerEnvironment(),...(options.device==="cpu"?{OMP_NUM_THREADS:"4",MKL_NUM_THREADS:"4",TOKENIZERS_PARALLELISM:"false"}:{})}, stdio: "pipe",
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (part: string) => this.read(part));
    // Drain diagnostics without saving arbitrary worker output.
    this.process.stderr.resume();
    this.process.on("error", () => this.fail(new RuntimeFailure("WORKER_START_ERROR", "Corpus worker could not start")));
    this.process.on("exit", () => this.fail(new RuntimeFailure("WORKER_EXIT", "Corpus worker exited")));
    this.process.stdin.on("error", () => this.fail(new RuntimeFailure("WORKER_WRITE_ERROR", "Corpus worker input failed")));
  }

  private fail(error: RuntimeFailure): void {
    this.failure ??= error;
    if (this.readyPending) { clearTimeout(this.readyPending.timer); this.readyPending.reject(this.failure); this.readyPending = undefined; }
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(this.failure); }
    this.pending.clear();
  }

  private read(part: string): void {
    this.buffer += part;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > this.maxFrameBytes) {
        this.fail(new RuntimeFailure("FRAME_TOO_LARGE", "Corpus worker response exceeded its frame limit"));
        this.process.kill();
        return;
      }
      try {
        const frame = object(JSON.parse(line));
        if (frame.type === "ready") {
          if (!this.expectReady || this.readyReceived || frame.version !== 1 || typeof frame.backend !== "string" || !frame.backend ||
            typeof frame.index_version !== "string" || !frame.index_version || Object.keys(frame).some((key) => !["version", "type", "backend", "index_version"].includes(key))) {
            throw new RuntimeFailure("PROTOCOL_ERROR", "Invalid or unexpected worker readiness event");
          }
          this.readyReceived = true;
          if (this.readyPending) {
            clearTimeout(this.readyPending.timer); this.readyPending.resolve(frame as unknown as WorkerReady); this.readyPending = undefined;
          }
          newline = this.buffer.indexOf("\n"); continue;
        }
        if (this.expectReady && !this.readyReceived) throw new RuntimeFailure("PROTOCOL_ERROR", "Corpus worker replied before readiness");
        if (frame.version !== 1 || typeof frame.request_id !== "string" ||
          (Object.hasOwn(frame, "result") === Object.hasOwn(frame, "error"))) {
          throw new RuntimeFailure("PROTOCOL_ERROR", "Invalid corpus worker response envelope");
        }
        const workerError = Object.hasOwn(frame, "error") ? object(frame.error) : undefined;
        if (workerError && (typeof workerError.code !== "string" || typeof workerError.message !== "string")) {
          throw new RuntimeFailure("PROTOCOL_ERROR", "Invalid corpus worker error envelope");
        }
        const pending = this.pending.get(frame.request_id);
        // Completed, cancelled, duplicate and late IDs can never settle a new request.
        if (pending) {
          this.pending.delete(frame.request_id);
          pending.cleanup();
          if (workerError) pending.reject(new RuntimeFailure(workerError.code as string, workerError.message as string));
          else pending.resolve(frame.result);
        }
      } catch {
        this.fail(new RuntimeFailure("PROTOCOL_ERROR", "Corpus worker emitted invalid JSONL"));
        this.process.kill();
        return;
      }
      newline = this.buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxFrameBytes) {
      this.fail(new RuntimeFailure("FRAME_TOO_LARGE", "Corpus worker response exceeded its frame limit"));
      this.process.kill();
    }
  }

  ready(): Promise<WorkerReady | undefined> { return this.readiness; }

  async request(method: ToolName, params: SearchParams | RetrieveParams, signal?: AbortSignal): Promise<unknown> {
    if (method !== "search_papers" && method !== "retrieve_chunks") {
      return Promise.reject(new RuntimeFailure("METHOD_NOT_ALLOWED", "Worker method is not allowed"));
    }
    return this.send(method,params,signal);
  }
  readScientificSources(params:ScientificParams,signal?:AbortSignal):Promise<unknown>{return this.send('read_scientific_sources',params,signal);}
  memoryOperation(params:Record<string,unknown>,signal?:AbortSignal):Promise<unknown>{return this.send('memory_operation',params,signal);}
  private async send(method:string,params:object,signal?:AbortSignal):Promise<unknown>{
    if (this.failure) return Promise.reject(this.failure);
    if (this.expectReady) await this.readiness;
    if (signal?.aborted) return Promise.reject(new RuntimeFailure("CANCELLED", "Corpus request cancelled"));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const rejectAndRemove = (error: RuntimeFailure) => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        pending.cleanup();
        reject(error);
      };
      const abort = () => rejectAndRemove(new RuntimeFailure("CANCELLED", "Corpus request cancelled"));
      const timer = setTimeout(() => rejectAndRemove(new RuntimeFailure("WORKER_TIMEOUT", "Corpus request timed out")), this.timeoutMs);
      this.pending.set(requestId, {
        resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); },
      });
      signal?.addEventListener("abort", abort, { once: true });
      this.process.stdin.write(`${JSON.stringify({ version: 1, request_id: requestId, method, params })}\n`, (error) => {
        if (error) rejectAndRemove(new RuntimeFailure("WORKER_WRITE_ERROR", "Corpus worker input failed"));
      });
    });
  }

  close(): void {
    this.fail(new RuntimeFailure("WORKER_CLOSED", "Corpus worker closed"));
    this.process.stdin.end();
    this.process.kill();
  }
}
