---
"dsh-tingfeng": minor
---

**修复**：短编号接进 `mnemon_recall`，搜 `Z015` 现在能直接拿到那一条。

**FIX**: short handles now resolve in `mnemon_recall`; `Z015` reaches that entry.

之前编号只被分配、只写进索引页，**但没有任何检索入口** —— 搜 `Z015` 走的是普通词法，
拿回一堆不相干的东西。功能只做了一半。

两步查找，因为 `mnemon` 本身不认识编号：

```
Z015 → short-ids.json → UUID → mnemon show <UUID> → 那一条
```

`memory-spaces` 源没有「按 id 取一条」的路由，为一个只在本插件用的查找新增一份契约
不划算，所以走 CLI。这也意味着**编号只在插件工具里有效**，`pwsh` 直接跑
`mnemon.exe` 搜不到 —— 那边永远不知道有编号这回事。

**回落是刻意的**：编号查不到（条目已删）时不报错、不返回空结果，而是**退回去走普通查询**。
因为一串长得像编号的文字仍可能真的是要搜的内容。

检索结果里 `mode: "handle"`、`score: 1`，与 `search` 精确命中的约定一致。

测试 3,380 全绿（新增 12 条）。
