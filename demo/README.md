# 问答示例

```powershell
npm run demo
```

展示一段多轮论文问答，包括问题、回答及引用的原文片段。

配置好模型和检索环境后，可在 CLI 中体验：

```powershell
npm run paper -- --session demo
```

1. 用 `/corpus` 搜索论文，`/scope` 设置范围。
2. 连续提问，比较论文方法或纠正回答要求。
3. 用 `/memory` 查看约束，用 `/trace` 查看执行过程。
4. 用 `/compact` 压缩上下文，再次启动同名会话继续问答。

示例数据保存在 `dialogue.json`。
