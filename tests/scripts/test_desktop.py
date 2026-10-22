import hashlib
import http.server
import json
import pathlib
import sys
import tempfile
import threading
import unittest
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from scripts.download_models import download_file
from desktop.resources import restore, digest, CORPUS, INDEX_FILES

class Download(unittest.TestCase):
    def serve(self, ignore_range=False):
        data = b"pinned model data" * 1024
        seen = []
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                header = self.headers.get("Range"); seen.append(header)
                offset = int(header.split("=")[1].split("-")[0]) if header and not ignore_range else 0
                self.send_response(206 if offset else 200)
                if offset: self.send_header("Content-Range", f"bytes {offset}-{len(data)-1}/{len(data)}")
                self.send_header("Content-Length", str(len(data)-offset)); self.end_headers(); self.wfile.write(data[offset:])
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_port}/weights", data, seen

    def test_resume_and_reuse_completed_model(self):
        url, data, seen = self.serve()
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory)/"model.bin"; path.with_suffix(".bin.partial").write_bytes(data[:101])
            download_file(url, path, len(data), hashlib.sha256(data).hexdigest(), progress=lambda _:None)
            self.assertEqual(path.read_bytes(), data); self.assertEqual(seen, ["bytes=101-"])
            download_file(url, path, len(data), hashlib.sha256(data).hexdigest())
            self.assertEqual(len(seen), 1)
            path.write_bytes(b"different")
            with self.assertRaises(ValueError): download_file(url, path, len(data), hashlib.sha256(data).hexdigest())
            self.assertEqual(path.read_bytes(), b"different")

    def test_server_ignoring_range_restarts_instead_of_appending(self):
        url, data, seen = self.serve(ignore_range=True)
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory)/"model.bin"; path.with_suffix(".bin.partial").write_bytes(data[:12])
            download_file(url, path, len(data), hashlib.sha256(data).hexdigest(), progress=lambda _:None)
            self.assertEqual(path.read_bytes(), data)

    def test_corrupt_download_is_not_installed(self):
        url, data, _ = self.serve()
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory)/"model.bin"
            with self.assertRaises(ValueError): download_file(url, path, len(data), "0"*64, progress=lambda _:None)
            self.assertFalse(path.exists())

class Resources(unittest.TestCase):
    def fixture(self, root):
        resource = root/"desktop/resources"; resource.mkdir(parents=True)
        index = "artifacts/bundled-cpu/pipaper-full-index-v1-0123456789abcdef"
        files = {CORPUS:b"paper source\n", **{index+"/"+name:b"source index\n" for name in INDEX_FILES}}
        archive = resource/"library.zip"
        with zipfile.ZipFile(archive,"w") as bundle:
            for name, data in files.items(): bundle.writestr(name,data)
        manifest = {"version":1,"index_dir":index,"archive_sha256":digest(archive),"files":{name:{"bytes":len(data),"sha256":hashlib.sha256(data).hexdigest()} for name,data in files.items()}}
        (resource/"manifest.json").write_text(json.dumps(manifest),encoding="utf8")
        return resource, files, manifest

    def test_restore_is_repeatable_and_refuses_changed_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); _, files, _ = self.fixture(root)
            restore(root); restore(root)
            for name, data in files.items(): self.assertEqual((root/name).read_bytes(),data)
            (root/CORPUS).write_bytes(b"changed")
            with self.assertRaises(ValueError): restore(root)
            self.assertEqual((root/CORPUS).read_bytes(),b"changed")

    def test_bundle_cannot_add_private_or_escape_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory); resource, _, manifest = self.fixture(root)
            manifest["files"]["../outside"]={"bytes":1,"sha256":"0"*64}
            (resource/"manifest.json").write_text(json.dumps(manifest),encoding="utf8")
            with self.assertRaises(ValueError): restore(root)
            self.assertFalse((root.parent/"outside").exists())

    def test_unexpected_archive_entry_and_corruption_are_rejected(self):
        for extra in ["configs/model.local.json", "../outside"]:
            with self.subTest(extra=extra), tempfile.TemporaryDirectory() as directory:
                root=pathlib.Path(directory); resource, _, manifest=self.fixture(root)
                with zipfile.ZipFile(resource/"library.zip","a") as bundle: bundle.writestr(extra,b"private")
                manifest["archive_sha256"]=digest(resource/"library.zip")
                (resource/"manifest.json").write_text(json.dumps(manifest),encoding="utf8")
                with self.assertRaises(ValueError): restore(root)

class BundledProduct(unittest.TestCase):
    def test_bundled_library_contains_only_source_papers_and_cpu_index(self):
        from desktop.resources import read_manifest
        manifest=read_manifest(ROOT)
        archive=ROOT/"desktop/resources/library.zip"
        self.assertEqual(digest(archive),manifest["archive_sha256"])
        with zipfile.ZipFile(archive) as bundle:
            self.assertEqual(set(bundle.namelist()),set(manifest["files"]))
            for name,meta in manifest["files"].items():
                data=bundle.read(name);self.assertEqual(len(data),meta["bytes"]);self.assertEqual(hashlib.sha256(data).hexdigest(),meta["sha256"])
            papers=[json.loads(line) for line in bundle.read(CORPUS).splitlines()]
            self.assertEqual(len(papers),manifest["paper_count"])
            for paper in papers:
                self.assertEqual(set(paper),{"paper_id","title","abstract","full_text"})
                for section in paper["full_text"]:
                    self.assertEqual(set(section),{"section_name","paragraphs"})
                    self.assertTrue(all(isinstance(p,str) for p in section["paragraphs"]))
            index=json.loads(bundle.read(manifest["index_dir"]+"/index-manifest.json"))
            self.assertEqual(index["identity"]["recipe"]["device"],"cpu")
            self.assertEqual(index["identity"]["dependencies"]["torch"],"2.9.1+cpu")
            self.assertFalse(index["gold_loaded"]);self.assertEqual(index["model_api_calls"],0)

    def test_product_package_uses_explicit_safe_paths(self):
        from desktop.build_windows import source_files
        files=source_files()
        self.assertIn("Start-AsterCite.cmd",files)
        self.assertIn("desktop/resources/library.zip",files)
        self.assertNotIn("configs/model.local.json",files)
        self.assertFalse(any(name.startswith(("tests/","reproduce/")) for name in files))
        for name in [".env", ".runtime/pi/auth.json", "configs/model.local.json", "docs/specs/private.md", "../outside", "AGENTS.md"]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root=pathlib.Path(directory); (root/"desktop").mkdir()
                (root/"desktop/product-files.json").write_text(json.dumps([name]),encoding="utf8")
                with self.assertRaises(ValueError): source_files(root)

if __name__ == "__main__": unittest.main()
