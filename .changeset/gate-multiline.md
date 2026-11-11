---
"dsh-tingfeng": patch
---

多行脚本里的 `>` 不再把下一行的路径当成自己的目标。

**A `>` no longer takes its path from the next line.**

写目标提取时空白用了 `\s`，它会跨行。于是一个两行的
`cp AGENTS.md /tmp/bak.md` + `cat AGENTS.md > /tmp/copy` 脚本里，
第一行的 `cp` 看起来写了第二行的路径，备份被误拦。

所有空白现在都是 `[ \t]`，操作数也不再含换行。多行脚本按行判定：
一行真写仍然拦，跨行的目标仍然认。
