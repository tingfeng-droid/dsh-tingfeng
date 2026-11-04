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
 * Turns that *mention* a domain without acting on it — design discussions,
 * research delegation, self-referential requests about this very feature —
 * must not trigger the reminder. Measured offline: these exclusions cut 9
 * false-positive turns out of 53 raw hits (precision 84% → measured on the
 * same 610-turn corpus).
 */
export const COLDLIB_HINT_EXCLUSIONS: readonly RegExp[] = [
  /研究/u, /讨论/u, /可行吗/u, /是不是能/u, /能不能行/u, /为什么/u, /会不会/u, /要不要/u,
  /思考/u, /单独讨论/u, /这个关键词/u, /避免你不去看冷库/u, /加到记忆插件/u, /解决注意力/u,
  /轮重发/u, /拉小队/u, /队员\s*\d/u, /咱俩/u, /聚焦/u, /说服力/u, /下一个版本/u,
  /这本来就是/u, /理论上/u,
]

/**
 * Returns the matching domain tags for one user message, or an empty array
 * when the turn should not carry a cold-library reminder.
 */
export function matchColdLibHint(text: string): readonly string[] {
  if (text.trim() === '') return []
  if (COLDLIB_HINT_EXCLUSIONS.some(pattern => pattern.test(text))) return []
  return COLDLIB_HINT_RULES.filter(rule => rule.pattern.test(text)).map(rule => rule.domain)
}

/**
 * One-line reminder naming the matched domains and the exact lookup command.
 * Kept to a single sentence: the model must learn *that* to search, *what*
 * domain, and *how* — nothing else.
 */
export function coldLibHintText(domains: readonly string[]): string {
  return `[冷库提醒] 本轮涉及：${domains.join('、')}。动手前先查冷库：mnemon search "<锚词>" --readonly --limit 20（480 空间条目另加 --store 480d6dc3-45f9-4a88-88b2-7ec46c1d1b4a；锚词见 ~/.agents/AGENTS.md 索引）。`
}
