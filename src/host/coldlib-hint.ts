import type { ColdLibHintRuleConfig, ResolvedColdLibHintConfig, ResolvedColdLibHintRule } from './protocol.ts'
/**
 * Cold-library keyword hints: when this turn's user text touches a domain the
 * cold library documents (plugin gates, model tables, VPS, wallpaper, ...),
 * inject a short instruction telling the model to consult the cold library
 * before acting. Reminder-only — never blocks or rewrites anything.
 *
 * The keyword table is derived from the audited path list (workspace doc
 * `44_路径提醒清单.md`): each entry maps user-phrased keywords to the cold
 * library entry that documents the pitfall for that domain. Reminder
 * frequency target: ~7% of real user turns (measured offline against 610
 * genuine user messages, 47 true-positive turns, precision 84% after the
 * design-discussion exclusions below).
 *
 * @module dsh-tingfeng/coldlib-hint
 */

/** One hint rule: user-phrased keywords for one cold-library domain. */
export interface ColdLibHintRule {
  /** Short domain tag surfaced in the reminder text. */
  readonly domain: string
  /** User-phrased keywords for this domain (action + object, not bare topics). */
  readonly pattern: RegExp
}

/**
 * Rules derived from the audited path list. Order matters only for the
 * reminder text (first matching domain is named); all matches gate the same
 * single reminder, so overlaps are harmless.
 *
 * This is the DEFAULT table. A profile that works a different set of domains
 * replaces it through `coldLibHint.rules`; nothing here is a constant of the
 * package.
 */
export const COLDLIB_HINT_RULES: readonly ColdLibHintRule[] = [
  { domain: '插件装卸与兼容闸门', pattern: /(?:装|卸载|卸掉|删掉|移除|升级|重装)[^。\n]{0,12}插件|(?:插件)[^。\n]{0,8}(?:装|卸载|升级)|装不了|插件全都在位|拿掉的那个插件/u },
  { domain: '本地模型与显存', pattern: /ollama|显存|拉模型|装模型|模型弄回来|本地模型|embedding|bge|同样的模型/u },
  { domain: '记忆系统与冷库', pattern: /冷库|热记忆|记忆文件|memories|精简记忆|整理记忆|写冷库|记忆加|加.{0,6}热记忆|写.{0,6}热记忆|规则和记忆|全局规则/u },
  { domain: '壁纸', pattern: /壁纸|wallpaper/u },
  { domain: '手机远程', pattern: /手机[^。\n]{0,12}(?:连|访问|显示|装|端)|frpc|远程连接/u },
  { domain: '账号池与渠道拦截', pattern: /账号池|令牌|token|保险柜|11128|反代|workbuddy|work上|渠道未验证|登录着/u },
  { domain: 'VPS 与域名', pattern: /vps|阿里云|防火墙|ufw|安全组|域名|r2049|备案|中继/u },
  { domain: 'GitHub 凭据', pattern: /github|推仓库|提pr|commit/iu },
  { domain: '盘与挂载', pattern: /挂载|ntfs|[cdeCDE]盘|windows分区/u },
  { domain: '冷库 CLI', pattern: /mnemon|冷库索引|搜冷库/u },
]

/**
 * The default rule table in the shape a profile config file can hold: the same
 * regular expressions as source text plus flags. Kept beside the compiled form
 * so a profile can copy one entry and edit it, and so a round-trip test can
 * prove the two spellings describe the same rules.
 */
export const COLDLIB_HINT_RULE_SOURCES: readonly { domain: string; keywords: string; flags: string }[] =
  COLDLIB_HINT_RULES.map(rule => ({
    domain: rule.domain,
    keywords: rule.pattern.source,
    flags: rule.pattern.flags,
  }))

/**
 * Turns that *mention* a domain without acting on it — design discussions,
 * research delegation, self-referential requests about this very feature —
 * must not trigger the reminder. Measured offline: these exclusions cut 9
 * false-positive turns out of 53 raw hits (precision 84% → measured on the
 * same 610-turn corpus).
 *
 * They apply per SENTENCE, not per message. A long message that both discusses
 * the feature and asks to act on a domain used to lose the whole turn to one
 * stray word: a real turn reading "…动作都需要记入冷库…这轮主要研究代码…" matched the
 * cold-store rule and was then suppressed by 「研究」, so the reminder never
 * fired for a message whose whole point was to consult the cold library.
 */
export const COLDLIB_HINT_EXCLUSIONS: readonly RegExp[] = [
  /研究/u, /讨论/u, /可行吗/u, /是不是能/u, /能不能行/u, /为什么/u, /会不会/u, /要不要/u,
  /思考/u, /单独讨论/u, /这个关键词/u, /避免你不去看冷库/u, /加到记忆插件/u, /解决注意力/u,
  /轮重发/u, /拉小队/u, /队员\s*\d/u, /咱俩/u, /聚焦/u, /说服力/u, /下一个版本/u,
  /这本来就是/u, /理论上/u,
]

/** The default exclusion list in the shape a profile config file can hold. */
export const COLDLIB_HINT_EXCLUSION_SOURCES: readonly string[] =
  COLDLIB_HINT_EXCLUSIONS.map(pattern => pattern.source)

/**
 * Turn one configured rule into a matcher, or undefined when it is unusable.
 * A rule that already carries a compiled `pattern` is passed through: config
 * objects are sometimes a resolved config spread back in (tests, live reload),
 * and recompiling a RegExp source is at best wasted work and at worst wrong.
 */
function compileRule(rule: { domain: string; keywords?: string; flags?: string; pattern?: RegExp }): ColdLibHintRule | undefined {
  if (rule.pattern instanceof RegExp) {
    const domain = rule.domain.trim()
    return domain === '' ? undefined : { domain, pattern: rule.pattern }
  }
  const domain = rule.domain.trim()
  if (domain === '' || typeof rule.keywords !== 'string' || rule.keywords.trim() === '') return undefined
  try {
    // Only the `u` and `i` flags are meaningful here, and `g`/`y` would make
    // `test()` stateful across sentences, so the flags are filtered rather than
    // trusted as given.
    const flags = (rule.flags ?? 'u').split('').filter(flag => flag === 'i' || flag === 'u').join('')
    return { domain, pattern: new RegExp(rule.keywords, flags.includes('u') ? flags : flags + 'u') }
  } catch {
    // A profile that mistypes a pattern must not take the engine down: the
    // rule is dropped and the rest of the table keeps working.
    return undefined
  }
}

/** Compile one configured exclusion; unparseable entries are dropped. */
function compileExclusion(source: string | RegExp): RegExp | undefined {
  if (source instanceof RegExp) return source
  if (typeof source !== 'string' || source.trim() === '') return undefined
  try {
    return new RegExp(source, 'u')
  } catch {
    return undefined
  }
}

/**
 * Resolve the effective table from a profile's configuration.
 *
 * An omitted `rules` keeps the built-in defaults (the common case: a machine
 * whose domains match the package's). A present but empty array means "no
 * rules", which is how a profile switches the reminder off without touching
 * `enabled` and losing the ability to switch it back on from the same place.
 * @param config - the profile's `coldLibHint` block, if any.
 * @returns the compiled table plus the switch.
 */
/**
 * Resolve the effective table from a profile's configuration.
 *
 * `null` (what the config schema fills in for an omitted field) keeps the
 * built-in defaults, the common case for a machine whose domains match the
 * package's. An empty array means "no rules", which is how a profile switches
 * the reminder off without touching `enabled` and losing the ability to switch
 * it back on from the same place.
 * @param config - the profile's `coldLibHint` block, if any.
 * @returns the compiled table plus the switch.
 */
export function resolveColdLibHint(config?: {
  enabled?: boolean
  rules?: readonly { domain: string; keywords?: string; flags?: string; pattern?: RegExp }[] | null
  exclusions?: readonly (string | RegExp)[] | null
}): ResolvedColdLibHintConfig {
  const rules = config?.rules == null
    ? COLDLIB_HINT_RULES
    : config.rules.map(compileRule).filter((rule): rule is ColdLibHintRule => rule !== undefined)
  const exclusions = config?.exclusions == null
    ? COLDLIB_HINT_EXCLUSIONS
    : config.exclusions.map(compileExclusion).filter((pattern): pattern is RegExp => pattern !== undefined)
  return { enabled: config?.enabled ?? true, rules: [...rules], exclusions: [...exclusions] }
}


/**
 * Split one turn's user text into clauses, so an exclusion only cancels the
 * clause it belongs to.
 *
 * The comma belongs here. A real turn read 「…动作都需要记入冷库，然后…这轮主要研究
 * 代码还有没有bug？」 — one sentence by the full-stop rule, so an exclusion on
 * 「研究」 still cancelled the 「记入冷库」 half. Chinese prose separates clauses
 * with commas far more often than with full stops, so treating only the latter
 * as a boundary leaves the whole message as one unit and the bug intact.
 * @param text - concatenated user text of the turn.
 * @returns the non-empty clauses, trimmed.
 */
export function coldLibHintSentences(text: string): string[] {
  return text
    .split(/[。！？；，、\n]+/u)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence !== '')
}

/**
 * Returns the matching domain tags for one user message, or an empty array
 * when the turn should not carry a cold-library reminder.
 *
 * Each sentence is judged on its own: a sentence that an exclusion pattern
 * marks as discussion contributes nothing, while any other sentence may still
 * raise its domain. That keeps a targeted request alive inside a long message
 * that happens to argue about the same topic.
 */
export function matchColdLibHint(
  text: string,
  rules: readonly ColdLibHintRule[] = COLDLIB_HINT_RULES,
  exclusions: readonly RegExp[] = COLDLIB_HINT_EXCLUSIONS,
): readonly string[] {
  const sentences = coldLibHintSentences(text)
    .filter(sentence => !exclusions.some(pattern => pattern.test(sentence)))
  if (sentences.length === 0) return []
  const domains: string[] = []
  for (const rule of rules) {
    if (sentences.some(sentence => rule.pattern.test(sentence)) && !domains.includes(rule.domain)) domains.push(rule.domain)
  }
  return domains
}

/**
 * One-line reminder naming the matched domains and the exact lookup command.
 * Kept to a single sentence: the model must learn *that* to search, *what*
 * domain, and *how* — nothing else.
 */
export function coldLibHintText(domains: readonly string[]): string {
  return `[冷库提醒] 本轮涉及：${domains.join('、')}。动手前先查冷库：mnemon search "<锚词>" --readonly --limit 20（480 空间条目另加 --store 480d6dc3-45f9-4a88-88b2-7ec46c1d1b4a；锚词见 ~/.agents/AGENTS.md 索引）。`
}
