# AsterCite

[![CI](https://github.com/Wahuwahuuu/AsterCite/actions/workflows/ci.yml/badge.svg)](https://github.com/Wahuwahuuu/AsterCite/actions/workflows/ci.yml)
[MIT License](LICENSE) · [下载 Windows 版](https://github.com/Wahuwahuuu/AsterCite/releases/latest) · [在线演示](https://astercite.niftyquail4.chatgpt.site)

面向科研论文多轮问答中的指代缺失、检索证据不足和无依据作答问题，基于 Pi SDK 搭建并优化轻量 Agent Harness，构建集 Query 改写、混合检索、引用生成和会话记忆于一体的分阶段可追溯问答 Agent。

安装后在自己的电脑上打开网页，选择论文、自由提问、连续追问并阅读原文引用。也可以通过 CLI 使用。

![AsterCite 网页工作台](docs/images/overview.jpg)

## 核心能力

- **混合检索**：BGE-M3 与 BM25 双路召回，RRF 融合，Cross-Encoder 重排。
- **多轮理解**：指代消解、Query 改写、跨论文比较与用户纠正。
- **证据引用**：回答附带论文、章节和原文片段，默认显示英文原文，点击按钮按需翻译为中文。
- **原文阅读**：全文滚动预览论文 PDF，悬停回答中的引用即可定位并高亮对应段落。
- **执行可见**：查看真实调用循环，点击节点阅读模型上下文、可见输出、工具参数与返回；推荐问题会选好对应论文。
- **逐篇分析**：勾选多篇进行分析或比较，逐篇列出引用与证据不足之处。
- **任务控制**：实时查看逐项任务进度，随时停止生成，保留收到的回答并继续追问。
- **会话管理**：结构化记忆、上下文压缩、会话恢复与阶段 Trace。
- **长期记忆**：Qdrant 保存阅读进度、笔记和回答偏好，新对话按需找回，支持查看、修改、删除与暂停。

## 快速开始

下载 [Windows x64 安装包](https://github.com/Wahuwahuuu/AsterCite/releases/latest)，安装后从开始菜单打开 AsterCite。

1. 首次启动会准备本地检索模型，下载中断后可继续。
2. 填写自己的模型服务地址、模型名称和密钥。
3. 浏览器自动打开后，即可围绕内置论文自由提问。

安装包附带论文库、检索索引和运行环境。推荐 Windows 10 / 11 x64、16 GB 内存、10 GB 可用空间；首次使用需要下载约 4.6 GB 的检索模型。使用方法见 [Windows 安装指南](docs/windows.md)。

## 从源码运行

需要 Node.js **24.11.1+**、Python **3.12**。先启动示例回放：

```powershell
git clone https://github.com/Wahuwahuuu/AsterCite.git
cd AsterCite
npm ci --ignore-scripts
npm run web
```

打开 `http://127.0.0.1:4173` 查看多轮问答示例，点击引用阅读原文。终端回放可使用 `npm run demo`。

使用自己的模型开展问答，先按 [安装指南](docs/environment.md) 构建本地检索环境，再配置模型：

```powershell
Copy-Item configs/model.example.json configs/model.local.json
```

填写服务地址与模型名称，在当前终端设置 `PIPAPER_API_KEY`，然后启动：

```powershell
npm run doctor
npm run web -- --live
```

网页会保存会话，支持论文范围、记忆查看和上下文压缩。网页用法与服务器部署见 [网页指南](docs/web.md)。

模型服务需支持 OpenAI Chat Completions、流式响应与工具调用。配置字段和密钥设置方法见 [配置指南](docs/configuration.md)。

## CLI 使用示例

运行 `npm run paper -- --session research`，然后输入：

```text
/corpus Sentence-BERT
/scope 1908.10084
这篇论文如何得到句向量？请给出原文依据。
它与交叉编码器有什么区别？
接下来用中文回答，只比较推理过程。
/memory
/trace
/quit
```

再次使用同名 `--session` 可继续会话；一次性提问可加 `--ask "你的问题"`。

| 命令 | 用途 |
|---|---|
| `/corpus` | 查找论文 |
| `/scope` | 设置当前论文范围 |
| `/memory` | 查看会话记忆 |
| `/long-memory` | 查看长期记忆；支持 `pause`、`resume`、`forget ID` 和 `clear` |
| `/trace` | 查看阶段执行记录 |
| `/tasks` | 查看上轮逐项任务进度 |
| `/compact` | 压缩上下文 |
| `/budget` | 查看会话用量 |
| `/help`、`/quit` | 帮助与退出 |

## 架构

```mermaid
flowchart LR
  CLI[用户提问] --> NLU[指代消解与 Query 改写]
  NLU --> Search[混合检索]
  Search --> Rerank[重排]
  Rerank --> Answer[带证据引用的回答]
  Answer --> Memory[会话记忆与压缩]
  Memory --> NLU
```

TypeScript 负责 Pi 会话编排、记忆和 CLI；Python worker 负责本地检索。模型通过 `search_papers` 与 `retrieve_chunks` 获取论文证据。

## 文档

- [Windows 安装版](docs/windows.md)
- [安装与检索环境](docs/environment.md)
- [模型与会话配置](docs/configuration.md)
- [演示示例](demo/README.md)
- [贡献指南](CONTRIBUTING.md)
- [版本记录](CHANGELOG.md)

原创代码采用 [MIT](LICENSE) 许可，数据与依赖来源见 [第三方说明](THIRD_PARTY.md)。
