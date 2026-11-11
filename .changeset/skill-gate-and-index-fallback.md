---
"dsh-tingfeng": minor
---

**新增** `skillGate`：写记忆/规则/索引前，先拦一次，要求读 `memory-curator` 技能。

**NEW**: an opt-in `skillGate` that refuses the first write of each turn until the
curator skill has been read.

**为什么需要它**：技能靠 `skill` 工具展开才进上下文。统计表明「写记忆前调技能」
这条规则在热记忆里的执行率是 39% —— 规则读过不代表照着做。闸门把「记得调」换成
「不调就写不了」。

**Why**: a skill only enters context when the `skill` tool opens it. A rule saying
"read it before writing" was in working memory and still went unexecuted 61% of
the time. A gate replaces remembering with being stopped.

**行为**：

- 拦第一下，返回一句提示（要求调 `skill memory-curator` 再重试）
- **同一个 turn 内第二次就放行** —— 否则重试也被拦，turn 会卡死
- 每个 turn 重新生效（不是每个会话一次：会话拉长后技能早已不在上下文里）
- **默认关**。这是个人工作流，不是每个用户都想要的行为
- 只拦写：`mnemon_recall`、`mnemon_document_search` 等读操作永不拦
- 只拦四个文件：`MEMORY.md` / `USER.md` / `~/.agents/AGENTS.md` / `~/.dsh/AGENTS.md`
  其它路径的 `write`/`edit` 一律放行（临时文件是最常见的写）
- `bash` 重定向进这四个文件同样拦；读这四个文件不拦

**如何打开**（profile 的 `cordis.patch.yml`）：

```yaml
      skillGate:
        enabled: true
        instruction: ""   # 留空用内置英文提示；写中文则用中文
```

**已知取舍**：闸门不验证技能是否真的被读过 —— 它只能看到工具调用，看不到 `skill`
工具的结果。所以「拦一次就放行」是刻意的：硬拦到底会让 turn 卡死，而提示本身
已经改变了下一步动作。
