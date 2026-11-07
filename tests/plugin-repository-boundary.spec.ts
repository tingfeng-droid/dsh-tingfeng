import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url))
const pluginNames = readdirSync(join(root, 'plugins')).filter(name => name.startsWith('dsh-tingfeng-')).sort()
const coreImports = new Set(['@tingfeng/dsh-tingfeng/contracts', '@tingfeng/dsh-tingfeng/extension-sdk', '@tingfeng/dsh-tingfeng/testing', '@tingfeng/dsh-tingfeng/client'])
const providerImports = new Set(['dsh-tingfeng-source-memory-spaces/provider-sdk', 'dsh-tingfeng-source-memory-spaces/testing'])
// Standard-slot extensions follow any main Strategy, so they do not depend on one.
const viewExtensions = new Set(['dsh-tingfeng-strategy-auto-capture', 'dsh-tingfeng-strategy-light-context', 'dsh-tingfeng-strategy-scoped'])
const threeTierOwner = 'dsh-tingfeng-strategy-default-three-tier'
const mainStrategies = [threeTierOwner, 'dsh-tingfeng-strategy-general']

function inside(directory: string, path: string): boolean {
  const child = relative(directory, path)
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

function imports(path: string): Array<{ specifier: string; typeOnly: boolean }> {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const result: Array<{ specifier: string; typeOnly: boolean }> = []
  function visit(node: ts.Node): void {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const typeOnly = ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly === true : node.isTypeOnly
      result.push({ specifier: node.moduleSpecifier.text, typeOnly })
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require') && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      result.push({ specifier: node.arguments[0].text, typeOnly: false })
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      result.push({ specifier: node.argument.literal.text, typeOnly: true })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}

function packageName(specifier: string): string {
  return specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/')
}

describe('standalone plugin repository boundary', () => {
  it('keeps four Sources, two main Strategies, three optional contributions and nine private Providers explicit', () => {
    expect(pluginNames.filter(name => name.startsWith('dsh-tingfeng-source-'))).toEqual([
      'dsh-tingfeng-source-documents', 'dsh-tingfeng-source-memory-spaces', 'dsh-tingfeng-source-runtime', 'dsh-tingfeng-source-skills',
    ])
    expect(pluginNames.filter(name => name.startsWith('dsh-tingfeng-strategy-'))).toEqual([...viewExtensions, ...mainStrategies].sort())
    expect(pluginNames.filter(name => name.startsWith('dsh-tingfeng-provider-'))).toHaveLength(9)
  })

  for (const name of pluginNames) it(`${name} owns its build, tests and declared public dependencies`, () => {
    const directory = join(root, 'plugins', name)
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    expect(manifest.name).toBe(name)
    expect(manifest.private).not.toBe(true)
    expect(manifest.exports['.']).toMatchObject({ types: './lib/index.d.ts', default: './lib/index.js' })
    for (const command of ['typecheck', 'test', 'build', 'verify']) expect(manifest.scripts[command]).toBeTruthy()
    for (const file of ['README.md', 'tsconfig.json', 'tsdown.config.ts', 'vitest.config.ts', 'src/index.ts', 'tests']) {
      expect(existsSync(join(directory, file)), `${name}/${file}`).toBe(true)
    }
    const configuration = JSON.parse(readFileSync(join(directory, 'tsconfig.json'), 'utf8'))
    expect(configuration.extends).toBeUndefined()
    expect(configuration.compilerOptions.paths).toBeUndefined()
    // Only `dependencies` and `peerDependencies` reach an installer, so only they
    // must carry real ranges. pnpm's `workspace:` protocol is the correct way to
    // link sibling packages inside this repository, and nested devDependencies are
    // stripped at pack time by `withoutWorkspaceDevLinks` (see scripts/release.mjs),
    // which is what keeps npm from rejecting the tarball with EUNSUPPORTEDPROTOCOL.
    // Asserting on devDependencies here rejected the repository's own layout.
    const published = { ...manifest.dependencies, ...manifest.peerDependencies }
    for (const [dependency, version] of Object.entries(published)) {
      expect(version, `${name} publishable dependency ${dependency}`).not.toMatch(/^(?:workspace:|file:|link:|\.\.?\/)/u)
    }
    // A workspace range in devDependencies is fine, but must be one the packer
    // knows how to strip; anything else would ship a protocol npm cannot parse.
    for (const [dependency, version] of Object.entries(manifest.devDependencies ?? {})) {
      if (!String(version).startsWith('workspace:')) continue
      expect(dependency, `${name} devDependency ${dependency} must be a sibling package`).toMatch(/^(?:@tingfeng\/dsh-tingfeng|dsh-tingfeng-)/u)
    }
    // Imports may be satisfied by any of the three fields; this set answers
    // "is this specifier declared at all", not "will it be published".
    const dependencies = { ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.devDependencies }
    const provider = name.startsWith('dsh-tingfeng-provider-')
    expect(manifest.peerDependencies[provider ? 'dsh-tingfeng-source-memory-spaces' : '@tingfeng/dsh-tingfeng']).toBeTruthy()
    if (provider) expect(manifest.peerDependencies['@tingfeng/dsh-tingfeng']).toBeUndefined()
    if (viewExtensions.has(name)) {
      expect(manifest.peerDependencies[threeTierOwner]).toBeUndefined()
      expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
      const patch = readFileSync(join(directory, 'cordis.patch.yml'), 'utf8')
      expect(patch).toContain(`name: ${name}`)
      expect(patch).toContain('disabled: true')
    }

    const files = ['src', 'tests'].flatMap(group => readdirSync(join(directory, group), { recursive: true })
      .filter(path => /\.[cm]?[jt]sx?$/u.test(String(path))).map(path => join(directory, group, String(path))))
    files.push(join(directory, 'tsdown.config.ts'), join(directory, 'vitest.config.ts'))
    const violations: string[] = []
    for (const file of files) {
      for (const { specifier } of imports(file)) {
        if (specifier.startsWith('.')) {
          if (!inside(directory, resolve(dirname(file), specifier))) violations.push(`${relative(root, file)} escapes to ${specifier}`)
          continue
        }
        if (isBuiltin(specifier)) continue
        if (packageName(specifier) === name && Object.hasOwn(manifest.exports, '.' + specifier.slice(name.length))) continue
        if (!Object.hasOwn(dependencies, packageName(specifier))) violations.push(`${relative(root, file)} has undeclared dependency ${specifier}`)
        const testOwner = viewExtensions.has(name) && file.includes(`${sep}tests${sep}`) && specifier === threeTierOwner
        if (specifier.startsWith('@tingfeng/dsh-tingfeng') && !(provider ? providerImports : coreImports).has(specifier) && !testOwner && !(file.includes(`${sep}tests${sep}`) && /^dsh-tingfeng-provider-[a-z0-9-]+$/u.test(specifier))) {
          violations.push(`${relative(root, file)} crosses its public contract: ${specifier}`)
        }
      }
      if (file.includes(`${sep}src${sep}`) && /\.(?:binding|mnemonMemorySpace)\b/u.test(readFileSync(file, 'utf8'))) {
        violations.push(`${relative(root, file)} reaches into a Host business binding`)
      }
    }
    expect(violations).toEqual([])
  })

  it('keeps the Strategy-owned SDK independent of its runtime policy and every Source implementation', () => {
    const entry = join(root, 'plugins', threeTierOwner, 'src/extension-sdk.ts')
    expect(imports(entry).map(item => item.specifier).sort()).toEqual(['@tingfeng/dsh-tingfeng/contracts', '@tingfeng/dsh-tingfeng/extension-sdk'])
  })

  it('keeps the pure Core import closure independent of Sources, Providers, clients and the default bundle', () => {
    const pending = [join(root, 'src/core/plugin.ts')]
    const visited = new Set<string>()
    const allowed = ['src/core', 'src/sdk'].map(directory => join(root, directory))
    const violations: string[] = []
    while (pending.length > 0) {
      const file = pending.pop()!
      if (visited.has(file)) continue
      visited.add(file)
      if (!allowed.some(directory => inside(directory, file)) && !inside(join(root, 'src/core'), file)) {
        violations.push(relative(root, file))
      }
      for (const { specifier, typeOnly } of imports(file)) {
        if (typeOnly) continue
        if (specifier.startsWith('.')) pending.push(resolve(dirname(file), specifier))
        else if (specifier.startsWith('@tingfeng/dsh-tingfeng') || specifier === 'react') violations.push(`${relative(root, file)}: ${specifier}`)
      }
    }
    expect(visited.size).toBeGreaterThan(3)
    expect(violations).toEqual([])
  })

  it('keeps component implementations out of the Starter client bundle', () => {
    // The client build bundles every import except React and the DSH primitives
    // (tsdown.config.ts), so a component package may reach it only as presentation
    // assets or types. Runtime settings also read the Source's public capacity
    // constants (no implementation), so the browser and Host use the same limits.
    // The implementation exception is what the Starter still draws of Memory
    // Spaces, taken through one module from Memory Spaces' own public client entry:
    // its settings, as a fallback for a version that registers none, the Status
    // page's Provider marks and the Mnemon Native Provider's id. The package size
    // ceiling no longer guards this.
    const gateway = join(root, 'src/client/memory-spaces-client.ts')
    const runtimeSettings = join(root, 'src/client/component-settings.tsx')
    const pending = [join(root, 'src/client/index.ts')]
    const visited = new Set<string>()
    const violations: string[] = []
    while (pending.length > 0) {
      const file = pending.pop()!
      if (visited.has(file)) continue
      visited.add(file)
      for (const { specifier, typeOnly } of imports(file)) {
        if (typeOnly) continue
        if (specifier.startsWith('.')) {
          const target = resolve(dirname(file), specifier)
          if (inside(join(root, 'plugins'), target)) violations.push(`${relative(root, file)}: ${specifier}`)
          else if (/\.tsx?$/.test(target)) pending.push(target)
        } else if (/^dsh-tingfeng-(?:source|provider|strategy)-/.test(specifier) && !/^dsh-tingfeng-source-[^/]+\/presentation\//.test(specifier)
          && !(file === gateway && specifier === 'dsh-tingfeng-source-memory-spaces/client')
          && !(file === runtimeSettings && specifier === 'dsh-tingfeng-source-runtime/contracts')) {
          violations.push(`${relative(root, file)}: ${specifier}`)
        }
      }
    }
    expect(visited.size).toBeGreaterThan(30)
    expect(violations).toEqual([])
    expect(visited.has(gateway)).toBe(true)
    expect(imports(gateway)).toEqual([{ specifier: 'dsh-tingfeng-source-memory-spaces/client', typeOnly: false }])
    const runtimeImport = ts.createSourceFile(runtimeSettings, readFileSync(runtimeSettings, 'utf8'), ts.ScriptTarget.Latest, true).statements
      .find(statement => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === 'dsh-tingfeng-source-runtime/contracts') as ts.ImportDeclaration
    const bindings = runtimeImport.importClause?.namedBindings
    expect(bindings !== undefined && ts.isNamedImports(bindings) ? bindings.elements.map(element => element.name.text).sort() : [])
      .toEqual(['RUNTIME_MEMORY_LIMITS', 'RUNTIME_MEMORY_LIMIT_MAX_BYTES'])
  })

  for (const [entry, allowed] of [
    ['src/sdk/index.ts', ['src/sdk', 'src/core/contracts', 'src/core/definitions.ts']],
    ['plugins/dsh-tingfeng-source-memory-spaces/src/provider-sdk.ts', [
      'plugins/dsh-tingfeng-source-memory-spaces/src/provider-sdk.ts',
      'plugins/dsh-tingfeng-source-memory-spaces/src/contracts.ts',
      ...['adapter', 'definitions', 'http', 'process'].map(name => `plugins/dsh-tingfeng-source-memory-spaces/src/providers/${name}.ts`),
    ]],
  ] as const) it(`${entry} does not load its private runtime or registries`, () => {
    const pending = [join(root, entry)]
    const visited = new Set<string>()
    const violations: string[] = []
    while (pending.length > 0) {
      const file = pending.pop()!
      if (visited.has(file)) continue
      visited.add(file)
      if (!allowed.some(path => inside(join(root, path), file))) violations.push(relative(root, file))
      for (const { specifier, typeOnly } of imports(file)) {
        if (typeOnly) continue
        if (specifier.startsWith('.')) pending.push(resolve(dirname(file), specifier))
        else if (!isBuiltin(specifier)) violations.push(`${relative(root, file)}: ${specifier}`)
      }
    }
    expect(visited.size).toBeGreaterThan(1)
    expect(violations).toEqual([])
  })
})
