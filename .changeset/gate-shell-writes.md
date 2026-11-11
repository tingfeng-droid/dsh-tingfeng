---
"dsh-tingfeng": patch
---

`skillGate` 覆盖命令行写入，并把 Windows 的写法一并拦住。

**Widen `skillGate` to shell writes on both platforms.**

原来只认 `> 文件` 这一种重定向。实测有六种等价写法能绕过：`tee`、`sed -i`、
`cp`、`mv`、`dd of=`、`rm`，Windows 侧还有 `Set-Content`、`Add-Content`、
`Out-File`、`Remove-Item`、`del`。

更糟的是：办公机**一半的冷库操作走 `pwsh` 直接跑 `mnemon.exe`**，不走插件工具。
只认 `bash` 等于那半边完全没盖住。现在 `bash` / `pwsh` / `powershell` 走同一条规则。

**仍然拦不住的**（刻意接受）：`python -c "open(...).write(...)"`、写个脚本再跑、
`node -e`。闸门是为了让人读技能，不是防有心绕过；每放宽一次都要多误拦一批读操作。

读这四个文件不拦 —— 查看记忆是每天要做几十次的事。
