/**
 * Cold-library keyword reminder.
 *
 * This module had no tests at all until 2026-11-08, which is why two defects
 * lived in it unnoticed: an exclusion pattern cancelled a WHOLE message (so a
 * long turn that both discussed the feature and asked to read the cold store
 * raised nothing), and the keyword table was a source constant (so the desktop
 * and the office machine overwrote each other's domains on every push).
 *
 * The cases below pin both, and pin the shape of the configuration a profile
 * writes, because a table that only exists in tests is a table nobody can set.
 */
import { describe, expect, it } from 'vitest'
import {
  COLDLIB_HINT_EXCLUSIONS,
  COLDLIB_HINT_EXCLUSION_SOURCES,
  COLDLIB_HINT_RULES,
  COLDLIB_HINT_RULE_SOURCES,
  coldLibHintSentences,
  coldLibHintText,
  matchColdLibHint,
  resolveColdLibHint,
} from '../src/host/coldlib-hint.ts'
import { resolveConfig } from '../src/host/config.ts'

describe('cold-library keyword reminder', () => {
  it('names the domains a concrete request touches', () => {
    expect(matchColdLibHint('装个插件试试')).toEqual(['插件装卸与兼容闸门'])
    expect(matchColdLibHint('冷库满了要整理')).toEqual(['记忆系统与冷库'])
    expect(matchColdLibHint('显存爆了')).toEqual(['本地模型与显存'])
    expect(matchColdLibHint('壁纸怎么换')).toEqual(['壁纸'])
  })

  it('stays quiet on turns that touch no documented domain', () => {
    expect(matchColdLibHint('今天天气不错')).toEqual([])
    expect(matchColdLibHint('帮我看下这段代码')).toEqual([])
    expect(matchColdLibHint('')).toEqual([])
  })

  it('does not fire for a message that only discusses the feature', () => {
    // The user asking *about* this mechanism is not an instruction to consult
    // the cold library; the exclusion list exists for exactly these turns.
    expect(matchColdLibHint('为什么冷库不触发')).toEqual([])
    expect(matchColdLibHint('讨论一下壁纸')).toEqual([])
  })

  it('judges exclusions per sentence, so a long turn keeps its real request', () => {
    // The regression. This turn both asks to write to the cold store and says
    // it wants the code researched; the old whole-message gate let 「研究」 cancel
    // the entire turn, so the reminder never fired for a message whose whole
    // point was the cold store.
    const turn = '这次记忆插件和压缩插件的动作都需要记入冷库，然后你重新客观的验证压缩插件，这轮主要研究代码还有没有bug？'
    expect(matchColdLibHint(turn)).toContain('记忆系统与冷库')

    // Same shape with the discussion clause first, so ordering cannot matter.
    expect(matchColdLibHint('我们讨论一下这个设计。先把结论记入冷库。')).toContain('记忆系统与冷库')
  })

  it('keeps a suppressed sentence from raising its own domain', () => {
    // The sentence that mentions the wallpaper is the discussion clause, and no
    // other sentence asks about it, so nothing fires — per-sentence judging
    // must not turn into "ignore exclusions entirely".
    expect(matchColdLibHint('为什么壁纸会黑屏')).toEqual([])
  })

  it('splits at Chinese stops and at newlines', () => {
    expect(coldLibHintSentences('一。二！三？四；五\n六')).toEqual(['一', '二', '三', '四', '五', '六'])
    expect(coldLibHintSentences('   \n\n  ')).toEqual([])
  })

  it('reports each domain once even when several sentences match it', () => {
    const domains = matchColdLibHint('冷库要整理。热记忆也满了。')
    expect(domains.filter(domain => domain === '记忆系统与冷库')).toHaveLength(1)
  })
})

describe('cold-library keyword table as configuration', () => {
  it('keeps the built-in table when the profile configures nothing', () => {
    const resolved = resolveColdLibHint(undefined)
    expect(resolved.enabled).toBe(true)
    expect(resolved.rules).toHaveLength(COLDLIB_HINT_RULES.length)
    expect(resolved.exclusions).toHaveLength(COLDLIB_HINT_EXCLUSIONS.length)
  })

  it('replaces the table with the profile machine own domains', () => {
    // This is the point of the change: a machine whose work differs carries its
    // own list, instead of both machines overwriting one shared constant.
    const resolved = resolveColdLibHint({
      enabled: true,
      rules: [
        { domain: 'OfficeCLI', keywords: 'officecli|工作区日报' },
        { domain: '门店', keywords: '门店|档口' },
      ],
      exclusions: ['讨论'],
    })
    expect(resolved.rules.map(rule => rule.domain)).toEqual(['OfficeCLI', '门店'])
    expect(matchColdLibHint('用 officecli 跑一下日报', resolved.rules, resolved.exclusions))
      .toEqual(['OfficeCLI'])
    // A domain the built-in table knows about is gone once replaced.
    expect(matchColdLibHint('壁纸怎么换', resolved.rules, resolved.exclusions)).toEqual([])
  })

  it('treats an empty rule array as no rules, keeping the switch available', () => {
    const resolved = resolveColdLibHint({ enabled: true, rules: [], exclusions: null })
    expect(resolved.rules).toEqual([])
    expect(matchColdLibHint('冷库满了要整理', resolved.rules, resolved.exclusions)).toEqual([])
  })

  it('drops a mistyped pattern instead of failing the whole table', () => {
    // A profile is edited by hand; one broken bracket must cost one rule, not
    // the engine. The alternative is a startup failure the user cannot read.
    const resolved = resolveColdLibHint({
      rules: [
        { domain: '坏的', keywords: '([unclosed' },
        { domain: '好的', keywords: '冷库' },
      ],
    })
    expect(resolved.rules.map(rule => rule.domain)).toEqual(['好的'])
  })

  it('ignores an empty domain or an empty pattern', () => {
    const resolved = resolveColdLibHint({
      rules: [
        { domain: '  ', keywords: '冷库' },
        { domain: '空的', keywords: '   ' },
        { domain: '有效', keywords: '冷库' },
      ],
    })
    expect(resolved.rules.map(rule => rule.domain)).toEqual(['有效'])
  })

  it('filters flags that would make test() stateful', () => {
    // `g` advances lastIndex between calls. Matching several sentences with one
    // regex would then skip matches depending on where the previous test ended.
    const resolved = resolveColdLibHint({ rules: [{ domain: '甲', keywords: '冷库', flags: 'giu' }] })
    expect(resolved.rules[0]?.pattern.flags.includes('g')).toBe(false)
    expect(resolved.rules[0]?.pattern.flags.includes('i')).toBe(true)
    expect(matchColdLibHint('冷库\n冷库', resolved.rules, resolved.exclusions)).toEqual(['甲'])
  })

  it('passes an already compiled rule through unchanged', () => {
    // A resolved config is sometimes spread back in as input; recompiling its
    // source text is wasted work, and recomputing it wrong would be worse.
    const pattern = /冷库/u
    const resolved = resolveColdLibHint({ rules: [{ domain: '甲', pattern }] })
    expect(resolved.rules[0]?.pattern).toBe(pattern)
  })

  it('ships the built-in table in the shape a profile would write', () => {
    // Round-trip: the published defaults must be copyable into a config file
    // and describe the same rules, or the documentation would teach a table
    // that behaves differently from the one in the code.
    expect(COLDLIB_HINT_RULE_SOURCES).toHaveLength(COLDLIB_HINT_RULES.length)
    const resolved = resolveColdLibHint({ rules: COLDLIB_HINT_RULE_SOURCES, exclusions: COLDLIB_HINT_EXCLUSION_SOURCES })
    expect(resolved.rules).toHaveLength(COLDLIB_HINT_RULES.length)
    for (const [index, rule] of resolved.rules.entries()) {
      expect(rule.domain).toBe(COLDLIB_HINT_RULES[index]?.domain)
      expect(rule.pattern.source).toBe(COLDLIB_HINT_RULES[index]?.pattern.source)
    }
    expect(resolved.exclusions).toHaveLength(COLDLIB_HINT_EXCLUSIONS.length)
  })
})

describe('cold-library keyword reminder through the profile config', () => {
  it('defaults to on with the built-in table', () => {
    const config = resolveConfig({})
    expect(config.coldLibHint.enabled).toBe(true)
    expect(config.coldLibHint.rules).toBeNull()
    expect(config.coldLibHint.exclusions).toBeNull()
  })

  it('keeps a configured table, and keeps an empty one distinct from unset', () => {
    const configured = resolveConfig({
      coldLibHint: { enabled: false, rules: [{ domain: '门店', keywords: '门店', flags: 'u' }], exclusions: [] },
    })
    expect(configured.coldLibHint).toEqual({
      enabled: false,
      rules: [{ domain: '门店', keywords: '门店', flags: 'u' }],
      exclusions: [],
    })
    // `[]` must survive: it means "no exclusions", which is not "use defaults".
    const empty = resolveConfig({ coldLibHint: { enabled: true, rules: [], exclusions: [] } })
    expect(empty.coldLibHint.rules).toEqual([])
    expect(empty.coldLibHint.exclusions).toEqual([])
  })

  it('turns the reminder into one line naming the domains and the command', () => {
    const text = coldLibHintText(['记忆系统与冷库', '冷库 CLI'])
    expect(text).toContain('记忆系统与冷库、冷库 CLI')
    expect(text).toContain('mnemon search')
    expect(text).not.toContain('\n')
  })
})

describe('cold-library keyword table follows a configuration swap', () => {
  it('recompiles when the profile config changes, not only at startup', () => {
    // An Agent outlives many configuration writes. The engine keeps a compiled
    // table keyed by the config object it came from, so a swap must produce a
    // different table — otherwise a live write appears to do nothing until the
    // next restart, while the plugin's other readers already see the new value.
    const first = resolveConfig({ coldLibHint: { enabled: true, rules: [{ domain: '甲', keywords: '甲词', flags: 'u' }], exclusions: null } })
    const second = resolveConfig({ coldLibHint: { enabled: true, rules: [{ domain: '乙', keywords: '乙词', flags: 'u' }], exclusions: null } })

    const a = resolveColdLibHint(first.coldLibHint)
    const b = resolveColdLibHint(second.coldLibHint)

    expect(a.rules.map(rule => rule.domain)).toEqual(['甲'])
    expect(b.rules.map(rule => rule.domain)).toEqual(['乙'])
    // The old table must not answer for the new config.
    expect(matchColdLibHint('乙词', a.rules, a.exclusions)).toEqual([])
    expect(matchColdLibHint('乙词', b.rules, b.exclusions)).toEqual(['乙'])
  })

  it('yields an identical table for an unchanged config object', () => {
    // The engine caches on object identity. Recompiling an unchanged config
    // would be wasted work on every turn; returning a different table would
    // mean the cache key is wrong.
    const config = resolveConfig({ coldLibHint: { enabled: true, rules: [{ domain: '甲', keywords: '甲词', flags: 'u' }], exclusions: null } })
    const first = resolveColdLibHint(config.coldLibHint)
    const second = resolveColdLibHint(config.coldLibHint)
    expect(second.rules[0]?.pattern.source).toBe(first.rules[0]?.pattern.source)
  })
})
