---
"dsh-tingfeng": minor
---

**BREAKING**: remove the `coldLibHint` keyword-reminder mechanism.

A turn no longer carries a reminder line naming the domains its user text matched.
The feature was reminder-only — it never blocked or rewrote anything — but its
keyword table was machine-specific: two machines that pushed to each other
overwrote one another's domains, and the built-in table only fit Chinese-language
profiles.

Removed with it: `src/host/coldlib-hint.ts`, the `coldLibHint` configuration block
(`enabled` / `rules` / `exclusions`), and `tests/coldlib-hint.spec.ts`.

**Upgrade note**: the `coldLibHint` block is no longer part of the schema. Remove
it from your profile's `cordis.patch.yml`; leaving it in place is ignored by the
loader but will fail a strict configuration check.

**中文**：本版移除了 `coldLibHint` 关键词提醒机制。该功能只在命中领域词时追加一行
「先查冷库」提示，从拦截或改写任何内容，但它的关键词表是机器相关的（两台机器互相
推送会覆盖对方的领域），且内置表只适用于中文 profile。

一并移除：`src/host/coldlib-hint.ts`、`coldLibHint` 配置块
（`enabled` / `rules` / `exclusions`）、`tests/coldlib-hint.spec.ts`。

**升级注意**：`coldLibHint` 已不在 schema 内，请从 profile 的 `cordis.patch.yml`
里删掉该块；留着不报错，但严格配置校验会失败。
