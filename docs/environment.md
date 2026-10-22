# 安装指南

本地检索环境：Windows x64、Node.js 24.11.1+、Python 3.12、uv 0.10.12。默认使用 CUDA 12.8 版 PyTorch；模型权重约需 4.6 GB 空间。

## 安装依赖

```powershell
npm ci --ignore-scripts
uv sync --frozen --extra retrieval
```

uv 安装方法见 [官方文档](https://docs.astral.sh/uv/getting-started/installation/)。

| 检索依赖 | 版本 |
|---|---|
| PyTorch | 2.9.1 / cu128 |
| Transformers | 4.57.3 |
| NumPy | 2.3.5 |
| FAISS | 1.15.1 |
| rank-bm25 | 0.2.2 |

## 准备语料与模型

```powershell
python scripts/restore_corpus.py --download
python scripts/download_models.py
```

语料来自 QASPER。脚本会下载论文文本和检索模型，文件保存在本地。

## 构建索引

```powershell
.venv\Scripts\python.exe -m retriever.p2 build --full --corpus-dir data/full-v1/corpus --models-dir .cache/models --artifacts-dir artifacts/full-v1 --device cuda
```

将构建输出的索引目录填入 `configs/model.local.json` 的 `retrieval.index_dir`。使用 CPU 时，将构建命令的 `--device` 和配置中的 `retrieval.device` 均设为 `cpu`。

检索采用段落内滑动窗口、BGE-M3 向量与 FAISS IndexFlatIP；BM25 提供稀疏召回，RRF 融合两路候选，Cross-Encoder 完成重排。模型版本及分块参数随索引清单保存。

## 检查环境

```powershell
npm run doctor
```

| 状态 | 处理方法 |
|---|---|
| `MISSING_KEY` | 在当前终端设置 `PIPAPER_API_KEY` |
| `INVALID_INDEX` | 核对配置中的语料、模型和索引目录 |
| `SESSION_LOCKED` | 检查同名会话是否仍在运行 |
| `INVALID_SNAPSHOT` | 使用匹配的配置恢复会话，或创建新会话 |

模型接入见 [配置指南](configuration.md)，网页启动与部署见 [网页指南](web.md)。
