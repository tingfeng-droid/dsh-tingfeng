---
"dsh-tingfeng": patch
---

编号大小写不敏感：`z016` 和 `Z016` 指向同一条。

**Handles are case-insensitive.**

表里只存一种拼法，输入时按前缀大小写归一。打字的人不会去想 shift 键。

前缀里若是正则元字符（如 `+`）现在会被转义，不再当成量词。
