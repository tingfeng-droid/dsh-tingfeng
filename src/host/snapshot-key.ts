/**
 * Age annotations the runtime Source renders above each entry, e.g.
 * `[created=35d]`, `[created=32d; updated=2d]`, `[importance=critical; created=2d; updated=1d]`.
 *
 * The Source derives the ages from wall-clock time when it projects the
 * snapshot (age() floors whole days), so the same entries render with a
 * different age after midnight. The ages carry no instruction, so they are
 * removed before two snapshots are compared for a change.
 *
 * The pattern is line-anchored because every entry is a single line
 * (normalizeContent folds all whitespace) and the Source joins entries with
 * `\n§\n`, so an annotation always starts its own line.
 */
const RUNTIME_AGE_ANNOTATION = /^\[(?=[^\]\n]*\b(?:created|updated)=)[^\]\n]*\]\n/gm

/**
 * One `key=value` part of an annotation, e.g. `created=35d`. The Source joins
 * the parts with `; ` and never emits a `;` inside a value, so a part never
 * spans the separator.
 */
const RUNTIME_AGE_PART = /^(?:created|updated)=[^;\]\n]*$/

/**
 * The change key of a runtime memory snapshot: its text without the age
 * annotations, so a snapshot whose only difference is a ticking age counts as
 * unchanged.
 *
 * `importance` stays in the key. It is a semantic property the model acts on,
 * and `replace` can change it on its own, so dropping it would swallow a real
 * change. The age parts are therefore removed from inside the annotation
 * rather than the whole annotation being dropped: an entry annotated
 * `[importance=critical; created=2d]` keeps its `importance` and loses only
 * its age, so a change to either is still visible in the key.
 *
 * A line whose annotation holds nothing but ages disappears entirely. A line
 * that mixes `importance` with ages keeps its remaining parts, rejoined the
 * way the Source writes them, so the key stays stable when an age appears or
 * disappears (age() omits `0d`).
 */
export function runtimeSnapshotChangeKey(text: string): string {
  return text.replace(RUNTIME_AGE_ANNOTATION, annotation => {
    const inner = annotation.slice(1, annotation.indexOf(']'))
    const kept = inner
      .split(';')
      .map(part => part.trim())
      .filter(part => part !== '' && !RUNTIME_AGE_PART.test(part))
    return kept.length === 0 ? '' : `[${kept.join('; ')}]\n`
  })
}
