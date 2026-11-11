---
"dsh-tingfeng": patch
---

闸门的 Windows 侧补齐：`-Path` 不再一律当作写入目标。

**Gate: `-Path` is a destination only on a writing verb.**

此前 `Get-Content -Path f`、`Select-String -Path f`、`Test-Path f` 都会被拦——
而这三个是最普通的读法。现在由**动词**决定：`Get-Content`/`Select-String`/`Test-Path`
参数里的路径是源，`Set-Content`/`Add-Content`/`Out-File`/`Copy-Item` 等的才是目标。

同时补上三个漏拦：`Copy-Item`/`Move-Item` 拷进来、`[System.IO.File]::WriteAllText`。
`Copy-Item A B` 与 `cp` 一样只认最后一个操作数，因此 `Copy-Item AGENTS.md C:\temp\bak.md`
这份备份不再被误拦。

Linux 39 个场景、Windows 26 个场景实测，误拦与漏拦均为 0。
