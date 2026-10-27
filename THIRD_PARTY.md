# 第三方来源

原创代码采用 MIT 许可。数据、论文与模型权重适用各自的来源许可。

| 来源 | 用途 | 许可 |
|---|---|---|
| [Pi SDK](https://github.com/earendil-works/pi) | Agent 会话编排 | MIT |
| [QASPER](https://huggingface.co/datasets/allenai/qasper/blob/main/README.md) | 论文语料 | CC BY 4.0 |
| [BGE-M3](https://huggingface.co/BAAI/bge-m3) | 稠密向量检索 | MIT |
| [BGE-reranker-v2-m3](https://huggingface.co/BAAI/bge-reranker-v2-m3) | Cross-Encoder 重排 | Apache-2.0 |
| FAISS、PyTorch、Transformers、rank-bm25 | 检索依赖 | 各上游包许可 |
| [Node.js](https://nodejs.org/) | Windows 版内置 JavaScript 运行时 | MIT 及附带第三方许可 |
| [CPython](https://www.python.org/)、[python-build-standalone](https://github.com/astral-sh/python-build-standalone) | Windows 版内置 Python 运行时 | PSF 及附带第三方许可 |
| [Microsoft Visual C++ Redistributable](https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist) | Windows 运行依赖 | Microsoft 软件许可 |

依赖版本见 `package-lock.json`、`uv.lock` 和 `desktop/requirements-win-x64.lock`；论文来源见 `data/full-v1/manifests/corpus.json`。内置论文文本来自 QASPER，保留论文标题与公开来源链接；问答示例中的原文片段来自对应的公开论文。安装版中各运行时与依赖包附带的许可证保留在对应目录。

## 参考资料

- Dasigi, P., Lo, K., Beltagy, I., Cohan, A., Smith, N. A., & Gardner, M. (2021). [A Dataset of Information-Seeking Questions and Answers Anchored in Research Papers](https://aclanthology.org/2021.naacl-main.365/). NAACL-HLT.
## PDF 阅读器

网页使用 Mozilla PDF.js 6.4.299（Apache-2.0），浏览器发行文件来自锁定的 `pdfjs-dist` 包。许可证保存在 `web/vendor/pdfjs-LICENSE`。论文 PDF 从各篇论文的官方 arXiv 页面获取，权利归原作者；本项目的源码许可证不覆盖论文。
