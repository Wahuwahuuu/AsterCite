# 第三方来源

原创代码采用 MIT 许可。数据、论文与模型权重适用各自的来源许可。

| 来源 | 用途 | 许可 |
|---|---|---|
| [Pi SDK](https://github.com/earendil-works/pi) | Agent 会话编排 | MIT |
| [QASPER](https://huggingface.co/datasets/allenai/qasper/blob/main/README.md) | 论文语料 | CC BY 4.0 |
| [BGE-M3](https://huggingface.co/BAAI/bge-m3) | 稠密向量检索 | MIT |
| [BGE-reranker-v2-m3](https://huggingface.co/BAAI/bge-reranker-v2-m3) | Cross-Encoder 重排 | Apache-2.0 |
| FAISS、PyTorch、Transformers、rank-bm25 | 检索依赖 | 各上游包许可 |

依赖版本见 `package-lock.json` 与 `uv.lock`；论文来源见 `data/full-v1/manifests/corpus.json`。问答示例中的原文片段来自对应的公开论文。

## 参考资料

- Dasigi, P., Lo, K., Beltagy, I., Cohan, A., Smith, N. A., & Gardner, M. (2021). [A Dataset of Information-Seeking Questions and Answers Anchored in Research Papers](https://aclanthology.org/2021.naacl-main.365/). NAACL-HLT.
