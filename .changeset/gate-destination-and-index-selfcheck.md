---
"dsh-tingfeng": minor
---

两处修正：闸门不再误拦只读，索引写盘前先自检。

**The gate no longer refuses a read, and a rendered index is checked before it lands.**

闸门此前只看命令里有没有四个文件名，因此 `cp AGENTS.md /tmp/backup`、
`cat AGENTS.md > /tmp/copy` 这类"读后导出"也被拦——而改索引前先备份正是常规动作。
现在改看**写入目标**：目标是那四个文件才拦，源是它们不拦。

索引在落盘前多三道自检：条数守恒、编号不为空、摘要不重复标题。任何一条不过就
**完全不写**，保留旧索引——一份坏索引比一份旧索引更糟，它是每轮注入的。

**Gate: destination, not mention.** A command is refused when one of the four
files is what it writes, not when one merely appears in it.

**Index: check before write.** Row count, handles, and descriptions are verified
against the entries collected; a failing block leaves the previous file intact.
