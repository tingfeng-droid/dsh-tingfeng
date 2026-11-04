export { name, inject, provide, Config, apply } from './host/plugin.ts'
export type { MnemonConfig } from './host/plugin.ts'
// The change key a runtime memory snapshot is compared on. Exported so the
// supersede rule can be tested against the built package instead of a copy.
export { runtimeSnapshotChangeKey } from './host/snapshot-key.ts'
