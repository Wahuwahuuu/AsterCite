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

`session` 配置会话轮次、请求超时和整轮超时。默认会话上限为 20 轮，每轮最多 12 次模型请求、2 次论文搜索与 4 次片段检索；`/budget` 可查看当前用量。

会话保存在 `.local/sessions/<name>/`，再次使用同名 `--session` 即可恢复。更换模型配置、源码或索引后，使用新的会话名。`/compact` 在下一轮执行上下文压缩。

异常退出留下锁文件时，先确认原进程已结束，再移除对应会话的 `session.lock`。
