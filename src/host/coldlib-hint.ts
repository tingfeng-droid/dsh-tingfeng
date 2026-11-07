/**
 * Cold-library keyword hints: when this turn's user text touches a domain the
 * cold library documents, inject a short instruction telling the model to
 * consult the cold library before acting. Reminder-only — never blocks or
 * rewrites anything.
 *
 * ── 2026-11-05 办公机（Windows）本地化重写 ──────────────────────────────
 *
 * 上游这份表是按**家庭机（Linux）的冷库**审计出来的（来源：`44_路径提醒清单.md`），
 * 家庭机与本机的冷库内容并不一样，直接沿用会两头错：
 *
 *   · 纯噪声：`壁纸`、`盘与挂载`（NTFS / C 盘 / Windows 分区）——本机冷库 83 条里
 *     一条都没有，家庭机在做壁纸和双系统盘挂载，本机没这回事。
 *   · 纯噪声：`本地模型与显存`——本机只有集显，没有任何本地模型
 *     （`ollama` 只用于 embedding，不是「装模型/拉模型」的场景）。
 *   · 大块漏网：手机 APK / 出包、坚果云双机、OfficeCLI 与工作区日报、
 *     门店评比客调流水线、DSH 主题与沙箱——这些本机冷库里都有条目，上游表一个都不认。
 *
 * 因此本文件的关键词表**按本机冷库 `~/.agents/AGENTS.md` 索引页重写**，
 * 每个领域都标注它兜住的是哪几条索引编号，便于下次核对。
 *
 * ── 2026-11-08 第二次审计（办公机）────────────────────────────────────────
 *
 * 方法：从最近 10 个会话抽出 **328 条真实用户消息**（`source.kind === 'user'`，
 * 剔除全部注入块），直接 import 本文件跑 `matchColdLibHint`，再用
 * 「删掉某个词后重测」量化每个词的贡献。脚本在
 * `工作区\_probe\audit_coldlib_hint2.mjs` 与 `audit_coldlib_words.mjs`。
 *
 * 审计结果：**命中率 25.0%**（46/184，其他 9 个会话，剔除当前压缩专题），
 * 目标是 ~7%。两个来源都找到了：
 *
 *   · 误报（约 18% 的命中是白提醒）：
 *     — 裸 `家庭机` 单独触发 6 条，其中 3 条明确无关（DeepSeek 服务器故障、
 *       npm 版本号、「我昨天让家庭机重做插件，消耗特别高」）⇒ 收窄成要求带动作。
 *     — 裸 `token` 单独触发 2 条，全是误报（「省 token」「耗费的 token」）⇒ 收窄成
 *       要求带令牌语义（刷新/过期/失效/文件/池）。
 *   · 漏网：
 *     — 「号」的口语说法（这个号 / 几个号 / 挪出去 / 登过来 / 号撞了）全漏。
 *     — 「记忆和规则」词序反了就不认（原表写死「规则和记忆」）。
 *     — 「项目记忆」「记忆插件」不认。
 *     — **整个压缩插件 / 发版领域缺失**（索引 #86-#90、#97 全都无覆盖）。
 *
 * 同时清理了 6 个失效的索引编号引用（#33 #42 #44 #55 #77 #80 —— 索引页 87 条里
 * 已不存在，是旧 83 条版本的残留）。
 *
 * ⚠️ 改了这里必须重新构建 + 打包 + 重装，光改 `lib/*.js` 会在下次 build 时被冲掉
 *    （家庭机 2026-11-05 已踩过同一个坑，见交接文档「教训 ④」）。
 * ⚠️ 重装前必须**先升 `package.json` 的 version**：`pnpm add` 对同路径同版本不替换文件。
 *
 * 提醒频率目标保持不变：~7% 的真实用户轮次。
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
 * Rules derived from THIS machine's cold-library index.
 *
 * 写法要求（沿用上游口径）：关键词是**用户会怎么说**（动作 + 对象），不是裸主题词。
 * 顺序只影响提醒文本里点名哪个领域；多条命中只发一条提醒，重叠无害。
 *
 * 每个领域后面的 `#NN` 是该领域在本机冷库索引页里对应的条目编号。
 */
export const COLDLIB_HINT_RULES: readonly ColdLibHintRule[] = [
  // #40 #49 —— 装插件、peer 门控、pnpm 姿势、配置改写纪律
  {
    domain: '插件装卸与兼容闸门',
    pattern:
      /(?:装|卸载|卸掉|删掉|移除|升级|重装)[^。\n]{0,12}插件|(?:插件)[^。\n]{0,8}(?:装|卸载|升级)|装不了|插件全都在位|拿掉的那个插件|peer\s*依赖|兼容闸门|skippedBundles/u,
  },

  // #12 #17 #74 —— 记忆运维真相、懒惰型记忆错乱、该不该灌 knowledge、记忆空间
  {
    domain: '记忆系统与冷库',
    // ⚠️ 2026-11-08：补「记忆和规则」等反序写法（原表只认「规则和记忆」，
    // 实测「复查整个记忆和规则」漏网）、「项目记忆」、「记忆插件」。
    pattern:
      /冷库|热记忆|记忆文件|记忆插件|memories|精简记忆|整理记忆|写冷库|记忆加|加.{0,6}热记忆|写.{0,6}热记忆|规则和记忆|记忆和规则|规则与记忆|记忆与规则|全局规则|记忆空间|项目记忆|mnemon\s*(?:db|库)/u,
  },

  // #12 #84 —— 冷库 CLI 本身（show/recall/search 用法、UUID、容量）
  {
    domain: '冷库 CLI',
    pattern:
      /mnemon\s*(?:cli|命令|show|recall|search|remember|embed)|冷库索引|搜冷库|查冷库|36\s*位|UUID/u,
  },

  // #86 #87 #88 #89 #90 #97 —— 压缩插件本体、dsh.client 崩溃、发版收尾链、npm 2FA、双机 git 分叉
  {
    domain: '压缩插件与发版',
    // ⚠️ 2026-11-08 新增：整个领域此前完全缺失。2026-11-07 一整天都在弄压缩插件，
    // 一次提醒都没弹过。索引页 #86-#90、#97 全部无覆盖。
    pattern:
      /(?:压缩插件|compaction|dsh-compaction|dsh-dcp|vcc)[^。\n]{0,12}(?:更新|升级|发版|装|卸|版本|配置|生效|改|坑)|发版|publish|npm\s*(?:发|发布|上架)|弃用|deprecat/u,
  },

  // #05 #19 #20 #21 #22 #31 #63 —— 手机通道、APK、出包、轻量版与老插件
  {
    domain: '手机远程与 APK',
    // ⚠️ 2026-11-05 实测修正：第一版要求「手机 + 连/访问/装…」，漏掉
    // 「手机上打开会话很慢」这类描述句。手机端的事几乎都该查冷库，放宽成
    // 只要出现「手机」且不是纯顺带提及（后面接「也/还」以外的空转）即可命中。
    pattern:
      /手机(?:上|端|里|那边|远程|通道|连接|打开|上看|版本|卡|断|连)|frpc|远程连接|APK|apk|出包|versionCode|打包\s*APK|turnWindow|dsh-mobile|老插件/u,
  },

  // #04 #08 #11 #32 #39 #41 #47 #48 #57 #58 #59 #66 #67 #68 #83 —— 账号池与上游对抗
  {
    domain: '账号池与渠道拦截',
    // ⚠️ 2026-11-08 两处修正：
    // ① 裸 `token` 有歧义 —— 「省 token」「耗费的 token」指的是上下文预算，不是令牌。
    //    实测 2 条误报全来自这里 ⇒ 收窄成必须带令牌语义。
    // ② 「号」的口语说法全漏 —— 「这个号已经撞了好几次」「手动挪出去了」
    //    「把另一个号登过来了」「几个号挤在同一秒」都没命中，而账号池是本机头号领域。
    pattern:
      /账号池|令牌|token[^。\n]{0,8}(?:刷新|过期|续期|失效|文件|池)|保险柜|11128|11133|11151|11140|反代|workbuddy|渠道未验证|登录着|掉号|冷却|cooling|巡检|命脉|查号|这个号|那个号|几个号|三个号|挪出|挪回|登过来|登录[^。\n]{0,4}号|号[^。\n]{0,4}(?:撞|封|异常|没了|恢复)/u,
  },

  // #15 #24 #36 #39 #57 #66 #67 —— 对抗策略、三层反指纹、上游收紧
  {
    domain: '反代与上游收紧',
    // ⚠️ 2026-11-08：补「抽检」「社区/生态」——「你去社区看整个生态的现状」属于
    // 上游生态调查，原表漏网。「社区」必须带上下文词，裸词会误报。
    pattern:
      /反指纹|指纹|上游收紧|封号|风控|UA|user-?agent|客户端身份|中转大户|抽检|整个生态|社区[^。\n]{0,6}(?:现状|生态|那边|看|里)/u,
  },

  // #01 #06 #07 #16 #35 #45 #52 #54 —— 选型、倍率、马甲、路由验证
  {
    domain: '模型选型与路由',
    pattern:
      /模型[^。\n]{0,10}(?:选|挑|换|哪个|倍率|便宜|贵)|倍率|马甲|模型代际|上下文窗口|模型路由|list_models|catalogSource/u,
  },

  // #03 #40 #60 —— GitHub 通路、peer 门控、写 PR 规矩
  {
    domain: 'GitHub 与 PR',
    pattern: /github|推仓库|提\s*pr|commit|ghfast|autocrlf|lfs|私有库|协作者/iu,
  },

  // #71 #75 —— 坚果云双机同步、双机信箱
  {
    domain: '坚果云与双机同步',
    // ⚠️ 2026-11-08 收窄：裸 `家庭机`/`办公机` 实测贡献 6 条命中，其中 3 条明确无关
    // （DeepSeek 服务器故障时提「家庭机没这个问题」、npm 版本号「030是家庭机提交的」、
    // 「我昨天让家庭机重做插件，消耗特别高」）。改成要求带上协作动作。
    // 代价：像「家庭机在做你那个方案」这类会漏 —— 可接受，上下文已点明机器。
    // ⚠️ 2026-11-08 二修：第一版写 `(?:告诉|通知|问)[^。\n]{0,4}(?:家庭机|办公机)`，
    // 裸 `问` 会把「是不是 DeepSeek 的问题？但是家庭机没这个问题」误判成
    // 「问」+「？但是」+「家庭机」⇒ 实体故障被报成双机同步。改成要求完整的
    // 问句动词，并禁止跨标点。
    pattern:
      /坚果云|nutstore|双机|同步目录|信箱|传给[^。\n]{0,6}(?:家庭|另一台)机|(?:告诉|通知|问问|问一下|问下)[^。\n？?]{0,6}(?:家庭机|办公机)|(?:家庭机|办公机)[^。\n]{0,10}(?:同步|传|推|拉取|对齐|那边|怎么样|回信|干活|做完了)/u,
  },

  // #69 #73 #50 #70 —— OfficeCLI、工作区日报、客调流水线
  {
    domain: 'OfficeCLI 与工作区日报',
    pattern:
      /OfficeCLI|iOfficeAI|工作区日报|客调|流水线|收集表|群\s*\d+|周表|门店|评比|日报/u,
  },

  // #53 #76 #79 #81 —— DSH 自身：主题、沙箱、vision 路由、卡顿、browser-skill
  {
    domain: 'DSH 自身与沙箱',
    pattern:
      /主题|沙箱|sandbox|只读模式|vision-?router|视觉路由|会话卡顿|卡顿|browser-skill|bsk|daemon/u,
  },

  // #14 #26 #28 —— 打补丁通用判据、不许自行安装部署、推荐纪律与已被否清单
  {
    domain: '打补丁与已被否清单',
    // ⚠️ 2026-11-05 实测修正：裸 `补丁` 会把「本机的三个补丁是哪三个」这种
    // 纯查问也触发。改成要求「要动手」，但**两种语序都收**：
    //   「把补丁重新打上」（补丁在前）、「打一个补丁」（动词在前）。
    // 第一版只写了动词在前，漏了前一种。
    pattern:
      /(?:打|写|加|重打|回滚|应用|做|重新打|补)(?:个|一个|一下)?\s*补丁|补丁[^。\n]{0,10}(?:怎么打|怎么加|要改|被冲掉|重新打|打上|加一个)|已被否|否过|推荐.{0,6}(?:插件|工具|方案)|不许.{0,6}(?:装|下载|部署)/u,
  },

  // #38 #51 #62 #68 —— 巡检脚本、pwsh 7、管理员权限
  {
    domain: '巡检与权限',
    pattern: /巡检脚本|命脉巡检|pwsh\s*7|PowerShell\s*7|管理员权限|gpedit|HKLM/u,
  },

  // #09 #21 #22 #23 —— 同类项目、APK 血泪教训、复核与拉小队
  {
    domain: '拉小队与复核',
    pattern:
      /拉小队|建队|队员|复核|反方|交叉验证|agent_teams|TingfengTeams|独立复审/u,
  },
]

/**
 * Turns that *mention* a domain without acting on it — design discussions,
 * research delegation, self-referential requests about this very feature —
 * must not trigger the reminder.
 *
 * ⚠️ 这一段是本机新增的：上游没有「讨论插件功能本身」这一类排除，
 * 实测会把自己在聊这条机制的话也当成触发（自指误报）。
 */
export const COLDLIB_HINT_EXCLUSIONS: readonly RegExp[] = [
  // 讨论/研究语气（不打算动手）
  // ⚠️ 2026-11-05 实测修正：裸 /为什么/ 会排掉「帮我看下 github 推送为什么失败」
  // ——那是排障，恰恰最该查冷库。改成只在「为什么这么做/是什么原理」这种
  // 追问设计时才排除，排障问句（为什么失败/报错/不通/坏）不排除。
  /研究/u, /讨论/u, /可行吗/u, /是不是能/u, /能不能行/u,
  /为什么(?:要|这么|那样|是这么|这样设计)|为什么(?:它|他|你)(?:能|会)做/u,
  /会不会/u, /要不要/u,
  /思考/u, /单独讨论/u, /理论上/u, /这本来就是/u, /下一个版本/u,
  /咱俩/u, /聚焦/u, /说服力/u,
  // 自指：只在「单纯讨论这个提醒本身」时排除。
  // ⚠️ 2026-11-05 实测修正：第一版写成裸 /冷库提醒/，把
  // 「冷库提醒的关键词是家庭机的，你得改成你的」也排掉了 —— 那恰恰是要动手的请求，
  // 方向刚好相反。自指必须同时带上「讨论/研究/怎么想」这类语气词才算。
  /(?:这个|那个)?冷库提醒[^。\n]{0,8}(?:要不要|该不该|需不需要|好不好|有意义吗|值不值)/u,
  /关键词表/u,
  /(?:这个|那个)功能/u,
  /这个关键词/u, /避免你不去看冷库/u, /加到记忆插件/u, /解决注意力/u,
  // 合作/流程类
  /轮重发/u, /队员\s*\d/u,
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
 *
 * ⚠️ 2026-11-05 本机实测修正（与上游文本的差异）：
 *   · 上游写 `mnemon search "<锚词>" --readonly --limit 20`，本机 CLI 0.2.10 **支持**
 *     `--readonly`（全局 flag）与 `--limit`，这条命令可用。
 *   · 上游还写了 `--store 480d6dc3-...`，**本机没有 `--store` 这个 flag**，
 *     且本机冷库只有 1 个空间 `default` ⇒ 已删掉，照抄会得到一条跑不通的命令。
 *   · 本机 `mnemon` 不在 PATH，必须用完整路径。已补进去。
 *   · ⚠️ 2026-11-05 更正：我昨天写「embedding coverage 0%、语义检索不可用」是**错的**。
 *     实测 `embed --status` 为 coverage 100%（83/83）、`embedding_available: true`、
 *     ollama 在跑、semantic 边 208 条。真正成立的是「`recall` 排序**不用** embedding 列」，
 *     所以仍要靠精确锚词，但这与「语义不可用」是两回事，不能混着说。
 */
export function coldLibHintText(domains: readonly string[]): string {
  return (
    `[冷库提醒] 本轮涉及：${domains.join('、')}。动手前先查冷库（本机 mnemon 不在 PATH）：\n` +
    `"C:\\Users\\39212\\.dsh\\tools\\mnemon\\mnemon.exe" recall "<锚词>" --basic --limit 30\n` +
    `锚词见 ~/.agents/AGENTS.md 索引页。` +
    `本机 embedding 覆盖 100%（语义可用），但 **recall 排序不用 embedding 列** ⇒ 仍只认精确锚词；` +
    `裸 recall 有图谱回退必返结果、search 按中文单字切会假阳，**只有 recall --basic 返 [] 才是真 0 命中**。`
  )
}
