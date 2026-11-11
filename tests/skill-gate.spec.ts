import { describe, expect, it } from 'vitest'
import { GATE_INSTRUCTION, SkillGate, gateDecision } from '../src/host/skill-gate.ts'
import type { ToolExecution } from '../src/host/dsh.ts'

/** A tool call shaped like the Host hands a guard: a name and parsed arguments. */
function call(name: string, args: unknown = {}): ToolExecution {
  return { name, arguments: args, signal: new AbortController().signal }
}

const on = { enabled: true }

describe('gateDecision', () => {
  it('refuses a memory write', () => {
    expect(gateDecision(call('mnemon_remember'), on)).toBe(GATE_INSTRUCTION)
    expect(gateDecision(call('mnemon_forget'), on)).toBe(GATE_INSTRUCTION)
    expect(gateDecision(call('mnemon_runtime_memory', { target: 'memory' }), on)).toBe(GATE_INSTRUCTION)
  })

  it('lets a read through — gating recall would stop the library being usable', () => {
    expect(gateDecision(call('mnemon_recall', { query: 'x' }), on)).toBeUndefined()
    expect(gateDecision(call('mnemon_document_search', { query: 'x' }), on)).toBeUndefined()
    expect(gateDecision(call('mnemon_memory_bodies'), on)).toBeUndefined()
  })

  it('refuses a write to each of the four files the curator owns', () => {
    for (const path of [
      '/home/a/.mnemon/runtime/MEMORY.md',
      '/home/a/.mnemon/runtime/USER.md',
      '/home/a/.agents/AGENTS.md',
      '/home/a/.dsh/AGENTS.md',
    ]) {
      expect(gateDecision(call('write', { file_path: path }), on), path).toBe(GATE_INSTRUCTION)
      expect(gateDecision(call('edit', { file_path: path }), on), path).toBe(GATE_INSTRUCTION)
    }
  })

  it('lets a write to any other file through — scratch files are most writes', () => {
    expect(gateDecision(call('write', { file_path: '/tmp/any.md' }), on)).toBeUndefined()
    expect(gateDecision(call('write', { file_path: '/home/a/project/src/index.ts' }), on)).toBeUndefined()
    // A file whose name merely ends in AGENTS.md elsewhere in the tree is the
    // project's own, not the injected one.
    expect(gateDecision(call('write', { file_path: '/home/a/project/AGENTS.md' }), on)).toBeUndefined()
  })

  it('refuses a shell redirect into a gated file', () => {
    expect(gateDecision(call('bash', { command: 'echo x > ~/.mnemon/runtime/MEMORY.md' }), on)).toBe(GATE_INSTRUCTION)
    expect(gateDecision(call('bash', { command: 'cat a >> ~/.agents/AGENTS.md' }), on)).toBe(GATE_INSTRUCTION)
  })

  it('does not refuse reading a gated file from the shell', () => {
    expect(gateDecision(call('bash', { command: 'cat ~/.mnemon/runtime/MEMORY.md' }), on)).toBeUndefined()
    expect(gateDecision(call('bash', { command: 'grep -c x ~/.agents/AGENTS.md' }), on)).toBeUndefined()
  })

  it('does nothing at all while switched off', () => {
    expect(gateDecision(call('mnemon_remember'), { enabled: false })).toBeUndefined()
    expect(gateDecision(call('write', { file_path: '/home/a/.agents/AGENTS.md' }), { enabled: false })).toBeUndefined()
  })

  it('uses the profile instruction when one is configured', () => {
    const custom = { enabled: true, instruction: '先读技能。' }
    expect(gateDecision(call('mnemon_remember'), custom)).toBe('先读技能。')
  })

  it('survives a call with no arguments or no name', () => {
    expect(gateDecision({ signal: new AbortController().signal }, on)).toBeUndefined()
    expect(gateDecision(call('write'), on)).toBeUndefined()
    expect(gateDecision(call('bash'), on)).toBeUndefined()
  })
})

describe('SkillGate', () => {
  it('refuses once, then lets the same call through', () => {
    const gate = new SkillGate(on)
    gate.beginTurn(1)
    expect(gate.guard(call('mnemon_remember'))).toBe(GATE_INSTRUCTION)
    // The retry the instruction asked for.
    expect(gate.guard(call('mnemon_remember'))).toBeUndefined()
    expect(gate.guard(call('mnemon_remember'))).toBeUndefined()
  })

  it('re-arms on the next turn', () => {
    const gate = new SkillGate(on)
    gate.beginTurn(1)
    expect(gate.guard(call('mnemon_remember'))).toBe(GATE_INSTRUCTION)
    expect(gate.guard(call('mnemon_remember'))).toBeUndefined()
    gate.beginTurn(2)
    expect(gate.guard(call('mnemon_remember'))).toBe(GATE_INSTRUCTION)
  })

  it('is not spent by a call it let through', () => {
    const gate = new SkillGate(on)
    gate.beginTurn(1)
    expect(gate.guard(call('mnemon_recall', { query: 'x' }))).toBeUndefined()
    // A read first must not use up the one refusal.
    expect(gate.guard(call('mnemon_remember'))).toBe(GATE_INSTRUCTION)
  })

  it('never refuses while switched off', () => {
    const gate = new SkillGate({ enabled: false })
    gate.beginTurn(1)
    expect(gate.guard(call('mnemon_remember'))).toBeUndefined()
  })
})
