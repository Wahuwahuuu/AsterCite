# 配置指南

将 `configs/model.example.json` 复制为 `configs/model.local.json`，填写自己的模型服务。API key 通过环境变量 `PIPAPER_API_KEY` 提供；本地配置与会话目录已加入 `.gitignore`。

## 模型参数

| 字段 | 说明 |
|---|---|
| `model.base_url` | OpenAI 兼容服务根地址，通常以 `/v1` 结尾 |
| `model.model_id` | 支持工具调用的模型名称 |
| `model.context_window` | 模型上下文容量 |
| `model.max_output_tokens` | 单次输出上限 |
| `model.reasoning` | 是否启用推理 |
| `model.thinking_level` | 推理等级；普通模型使用 `off` |

推理模型可设置 `reasoning: true`、`thinking_level: "low"` 和 `compat.supportsReasoningEffort: true`。具体兼容参数以服务文档为准。

`compat` 支持 `supportsStore`、`supportsDeveloperRole`、`supportsReasoningEffort`、`supportsUsageInStreaming`、`supportsFinishReason`、`requiresToolResultName`、`requiresAssistantAfterToolResult` 与 `zaiToolStream`。`maxTokensField` 可选 `max_tokens` 或 `max_completion_tokens`；`thinkingFormat` 使用 Pi SDK 支持的格式。

## 设置密钥

在 PowerShell 中交互输入：

```powershell
$credential = Get-Credential -UserName api -Message "密码栏输入模型 API key"
$env:PIPAPER_API_KEY = $credential.GetNetworkCredential().Password
npm run doctor
npm run paper -- --session research
```

密钥保存在当前终端环境中。结束后可执行 `Remove-Item Env:PIPAPER_API_KEY` 清除。

## 检索与会话

`retrieval` 指定语料、索引、模型目录与设备。构建索引的方法见 [安装指南](environment.md)。

`session` 配置会话轮次、请求超时和整轮超时。默认会话上限为 20 轮。普通问题每轮最多 12 次模型请求、2 次论文搜索与 4 次片段检索；多篇比较会随论文数量增加调用预算。例如，选择五篇论文时，最多允许 27 次模型请求、15 次片段检索，证据足够时会提前结束。`/budget` 可查看当前用量。

比较时先逐篇查找原文，再核对各篇论文在比较维度上的缺项，按需补查并去除重复片段。回答以比较表展示差异，并说明未找到充分证据的项目。每次检索默认返回八个片段，最多二十个；可继续检索或分页读取表格、公式。执行过程保留每次实际请求、工具调用及返回内容。

CLI 会话保存在 `.local/sessions/<name>/`，再次使用同名 `--session` 即可恢复。网页会话支持升级后继续使用；换用其他论文库时需要新建会话。`/compact` 在下一轮执行上下文压缩。自动压缩按保留的实际上下文占用达到窗口的 70% 触发；请求前还会为输出与工具信息预留空间。手动与自动压缩采用相同的保留策略。

网页问答过程中可点击“停止生成”。停止只针对当前轮，已经收到的内容会保存，实际请求仍计入会话用量。CLI 可用 Ctrl+C 停止当前轮，使用 `/tasks` 查看保存的任务进度。

问题理解阶段按模型窗口分配历史内容，空间足够时保留完整回答。追问某一轮或回答末尾时优先保留对应内容；空间不足时附上原文摘录范围和省略提示，完整对话仍保存在本地。执行详情中的 `history_context` 可查看本次包含、省略和截取了哪些历史内容。

异常退出留下锁文件时，先确认原进程已结束，再移除对应会话的 `session.lock`。
