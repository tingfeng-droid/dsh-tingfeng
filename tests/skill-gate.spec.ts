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

describe('shell commands that write a gated file', () => {
  const shell = (command: string) => call('bash', { command })
  const G = ['AGENTS', 'md'].join('.')
  const A = `~/.agents/${G}`
  const M = `~/.mnemon/runtime/${['MEMORY', 'md'].join('.')}`

  it('refuses every POSIX idiom that writes the file', () => {
    for (const command of [
      `echo x > ${A}`,
      `cat a >> ${A}`,
      `echo x | tee ${M}`,
      `sed -i 's/a/b/' ${A}`,
      `perl -pi -e 's/a/b/' ${A}`,
      `cp /tmp/x ${A}`,
      `mv /tmp/x ${A}`,
      `dd if=/dev/zero of=${A}`,
      `rm ${A}`,
    ]) {
      expect(gateDecision(shell(command), on), command).toBe(GATE_INSTRUCTION)
    }
  })

  it('refuses the PowerShell idioms, because the same profile runs on Windows', () => {
    for (const command of [
      `Set-Content -Path ${A} -Value x`,
      `Add-Content ${M} x`,
      `'x' | Out-File ${A}`,
      `Remove-Item ${A}`,
      `del ${A}`,
    ]) {
      expect(gateDecision(shell(command), on), command).toBe(GATE_INSTRUCTION)
    }
  })

  it('lets every read through — looking at memory is a daily action', () => {
    for (const command of [
      `cat ${M}`,
      `grep -c x ${A}`,
      `wc -l ${A}`,
      `head -20 ${M}`,
      `Get-Content ${M}`,
      `Select-String -Pattern x ${A}`,
    ]) {
      expect(gateDecision(shell(command), on), command).toBeUndefined()
    }
  })

  it('ignores a command that only mentions the name in passing', () => {
    expect(gateDecision(shell('echo "MEMORY.md 是什么"'), on)).toBeUndefined()
    expect(gateDecision(shell('git status'), on)).toBeUndefined()
    expect(gateDecision(shell('echo hi > /tmp/a.txt'), on)).toBeUndefined()
  })

  it('gates pwsh and powershell by the same rule as bash', () => {
    expect(gateDecision(call('pwsh', { command: `echo x > ${A}` }), on)).toBe(GATE_INSTRUCTION)
    expect(gateDecision(call('powershell', { command: `cat ${M}` }), on)).toBeUndefined()
  })
})


describe('reading a gated file is never refused', () => {
  const A = '~/.agents/' + ['AGENTS', 'md'].join('.')
  const R = '~/.mnemon/runtime/' + ['MEMORY', 'md'].join('.')

  /** Every one of these only reads. Backing the index up before editing it is routine. */
  const reads = [
    `wc -l ${A}`,
    `cat ${A}`,
    `grep -n xx ${A}`,
    `sed -n '1,20p' ${A}`,
    `head -c 200 ${R}`,
    `diff ${A} /tmp/bak`,
    `md5sum ${R}`,
    `cat ${A} > /tmp/copy.txt`,
    `grep -c x ${A} | tee /tmp/out.txt`,
    `cp ${A} /tmp/backup.md`,
    `cp -a ${A} /tmp/dir/`,
    `sed -n '1,5p' ${A} > /tmp/x`,
  ]

  for (const command of reads) {
    it(`lets through: ${command}`, () => {
      expect(gateDecision(call('bash', { command }), { enabled: true })).toBeUndefined()
    })
  }

  /** The destination decides: these write a gated file, so they must be refused. */
  const writes = [
    `echo x > ${A}`,
    `cat /tmp/x > ${A}`,
    `cp /tmp/x ${A}`,
    `mv /tmp/x ${A}`,
    `sed -i 's/a/b/' ${A}`,
    `dd if=/dev/zero of=${R}`,
    `echo x | tee ${A}`,
    `Set-Content -Path ${A} -Value x`,
    `Remove-Item ${A}`,
  ]

  for (const command of writes) {
    it(`refuses: ${command}`, () => {
      expect(gateDecision(call('bash', { command }), { enabled: true })).toBeTypeOf('string')
    })
  }
})

describe('PowerShell: reading is never refused', () => {
  const F = ['AGENTS', 'md'].join('.')
  const M = ['MEMORY', 'md'].join('.')
  const A = `C:\\Users\\39212\\.agents\\${F}`
  const R = `C:\\Users\\39212\\.mnemon\\runtime\\${M}`

  /**
   * `-Path` appears on reads too — `Get-Content -Path f` is the ordinary way to
   * read a file, and refusing it was the widest false positive the gate had.
   * The verb decides, not the parameter name.
   */
  const reads = [
    `Get-Content ${A}`,
    `Get-Content -Path ${A}`,
    `Get-Content -Path ${A} -TotalCount 20`,
    `Get-Content -Raw ${R}`,
    `Select-String -Path ${A} -Pattern xx`,
    `Select-String xx ${A}`,
    `Test-Path ${A}`,
    `Get-FileHash ${A}`,
    `Get-Item ${A}`,
    `Measure-Object -Line ${A}`,
    `(Get-Content ${A}).Count`,
    `[System.IO.File]::ReadAllText('${A}')`,
    `Copy-Item ${A} C:\\temp\\bak.md`,
    `Get-Content ${A} | Set-Content C:\\temp\\x.txt`,
    `Get-Content ${A} | Out-File C:\\temp\\x.txt`,
  ]

  for (const command of reads) {
    it(`lets through: ${command}`, () => {
      expect(gateDecision(call('pwsh', { command }), { enabled: true })).toBeUndefined()
    })
  }

  const writes = [
    `echo x > ${A}`,
    `echo x | Set-Content ${A}`,
    `Set-Content -Path ${A} -Value x`,
    `Add-Content ${A} x`,
    `Out-File ${A}`,
    `Remove-Item ${A}`,
    `Copy-Item C:\\temp\\x.md ${A}`,
    `Move-Item C:\\temp\\x.md ${A}`,
    `[System.IO.File]::WriteAllText('${A}', 'x')`,
  ]

  for (const command of writes) {
    it(`refuses: ${command}`, () => {
      expect(gateDecision(call('pwsh', { command }), { enabled: true })).toBeTypeOf('string')
    })
  }
})
