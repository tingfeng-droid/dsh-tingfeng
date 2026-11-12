import { execFileSync } from 'node:child_process'
import { findMnemonCommand } from 'dsh-tingfeng-source-memory-spaces/native-cli'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ColdIndexSync } from './cold-index-sync.ts'
import { describeEntry, parseLibrary, SUMMARY_PROMPT, updateIndex, type IndexEntry } from './cold-index.ts'
import { Context } from '@deepseek-ai/cordis'
import { Config as PlainConfig, InteractionConfig, resolveConfig, resolveInteractionConfig, SkillsConfig, type Config as MnemonConfig } from './config.ts'
import { MnemonAutoBackupScheduler } from './auto-backup.ts'
import { registerCommands } from './commands.ts'
import type { HostContextShape, HostCredentialsService, HostWorkspaceRegistry } from './dsh.ts'
import { githubGrantFromRecord, MNEMON_SYNC_GITHUB_CREDENTIAL_KEY, MnemonGitHubAuth, type MnemonGitHubCredentialPort } from './github-auth.ts'
import { registerGuidance } from './guidance.ts'
import { createRuntimeGraph, LiveMnemonRuntime } from './runtime.ts'
import { MnemonLifecycle, taskRoute } from './lifecycle.ts'
import { SkillEvolution } from './skill-evolution.ts'
import { DEFAULT_SKILLS_CONFIG, type ResolvedSkillsConfig } from './protocol.ts'
import { skillsSourceFor } from './skill-source.ts'
import { registerRpc } from './rpc.ts'
import { hasNativeDirectoryPicker } from './directory-picker.ts'
import { migrateLegacyDisplayMode, registerSettingsRpc } from './settings.ts'
import { MnemonSubagentCoordinator } from './subagent.ts'
import { createStorageRoot } from './storage-root.ts'
import { ShortIdStore } from './short-ids.ts'
import { registerTools } from './tools.ts'
import { registerMnemonSubagentTokenUsageProjection } from './subagent-token-usage.ts'
import { provideMemoryRuntime } from '../core/runtime.ts'
import { MemoryPluginManagement } from './plugin-management.ts'
import { registerViewRpc } from './view-rpc.ts'
import { MemoryPluginInstallation } from './plugin-installation.ts'
import { MnemonRemoteService } from './remote-rpc.ts'
import { plainHostConfig, type LiveHostConfig } from './live-config.ts'
import { ProfileMnemonSettings } from './settings-service.ts'
import { dshPluginCommand, VersionUpdateManager, type DshBundleInstaller } from './version-updates.ts'

export const name = 'dsh-tingfeng'
export const provide = ['mnemonMemory']
export const inject = ['tools', 'settings', 'commands', 'agents', 'subagents']
export { LiveConfig as Config } from './live-config.ts'
export type { MnemonConfig }

/** Resolve the optional Web workspace service at call time, not plugin-mount time. */
function optionalWorkspaceRegistry(ctx: HostContextShape): HostWorkspaceRegistry {
  const current = (): HostWorkspaceRegistry | undefined => ctx.get('workspaceRegistry') as HostWorkspaceRegistry | undefined
  return {
    get: id => current()?.get(id),
    list: () => current()?.list() ?? [],
  }
}

/**
 * The one credentials record this plugin keeps, as DSH's store addresses it:
 * `<scope>/<id>`. Presence of the record is the whole fact, and every write
 * goes through `modifyRecord` so a replacement happens under the store's lock.
 */
function credentialPort(service: () => HostCredentialsService | undefined): MnemonGitHubCredentialPort {
  return {
    available: () => service() !== undefined,
    describe: async () => {
      const store = service()
      if (store === undefined) return { configured: false, writable: false }
      const info = await store.describeRecord(MNEMON_SYNC_GITHUB_CREDENTIAL_KEY)
      return { configured: info.configured, writable: info.writable }
    },
    read: async () => githubGrantFromRecord(await service()?.readRecord(MNEMON_SYNC_GITHUB_CREDENTIAL_KEY)),
    write: async grant => {
      const store = service()
      if (store === undefined) throw new Error('this DSH Host provides no credentials store, so GitHub sign-in is unavailable')
      await store.modifyRecord(MNEMON_SYNC_GITHUB_CREDENTIAL_KEY, async () => ({ kind: 'grant', payload: grant }))
    },
    clear: async () => {
      const store = service()
      if (store === undefined) return
      // An absent record is already the signed-out state; deleting one twice is not a failure.
      if (await store.readRecord(MNEMON_SYNC_GITHUB_CREDENTIAL_KEY) === undefined) return
      await store.deleteRecord(MNEMON_SYNC_GITHUB_CREDENTIAL_KEY)
    },
  }
}

/**
 * GitHub sign-in lives beside the sync channel, not inside it: one instance
 * spans every runtime generation, so a grant stored from the settings page is
 * the same one an Agent's workspace graph resolves. The credentials service is
 * read at call time, because a Headless profile may mount none at all.
 */
function optionalGitHubAuth(ctx: HostContextShape): MnemonGitHubAuth {
  const current = (): HostCredentialsService | undefined => (ctx.get('credentials') ?? ctx.credentials) as HostCredentialsService | undefined
  return new MnemonGitHubAuth(credentialPort(current))
}

/** DSH owns assembly; this Host only wires scope, phases and user preferences. */
/**
 * The scheduled regeneration of a cold-library index, or undefined when the
 * profile did not switch it on.
 *
 * Reading the library goes through the CLI on purpose: `mnemon recall '' --basic`
 * lists every row, while the recall route answers by relevance and stops at a
 * tier, so an index built from that would quietly lose whatever ranked last.
 */
function coldIndexSync(
  config: LiveMnemonRuntime['config'],
  dataDir: string,
  coordinator: MnemonSubagentCoordinator,
  runtime: LiveMnemonRuntime,
  shortIds: ShortIdStore | undefined,
): ColdIndexSync | undefined {
  const settings = config.indexSync
  if (!settings.enabled) return undefined
  const markers = { begin: settings.beginMarker, end: settings.endMarker }
  const collect = async (): Promise<IndexEntry[]> => {
    // Same discovery as every other CLI call — see the note in tools.ts cliLookup.
    const command = findMnemonCommand({ ...(config.cliPath === undefined ? {} : { cliPath: config.cliPath }) }) ?? 'mnemon'
    const argv = ['--data-dir', dataDir, 'recall', '', '--basic', '--limit', '100000', '--readonly']
    const stdout = execFileSync(command, argv, {
      encoding: 'utf8',
      timeout: config.timeoutMs,
      env: { ...process.env, MNEMON_EMBED_MODEL: config.embedding.model },
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    })
    const entries = parseLibrary(stdout)
    // Fill handles for rows that predate the feature. Doing it here rather than
    // only on write is what makes a fresh install on an existing library come out
    // numbered instead of showing a column of blanks that a reader has to skip,
    // and what keeps the index from being refused for rows the table has no
    // handle for. Idempotent, so later builds cost one read and no write.
    if (shortIds !== undefined) {
      try {
        shortIds.ensure(entries.map(entry => {
          const { title } = describeEntry(entry)
          return { id: entry.id, store: entry.store, title }
        }))
      } catch {
        // A damaged or unwritable table must not stop the index from being built:
        // the entries are still in the library, only their handles are missing.
      }
    }
    return entries
  }
  const summarize = settings.summary.provider === 'ollama'
    ? async (content: string): Promise<string | undefined> => {
      const controller = new AbortController()
      const timer = setTimeout(() => { controller.abort() }, 20_000)
      timer.unref?.()
      try {
        const response = await fetch(`${settings.summary.endpoint.replace(/\/+$/u, '')}/api/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: settings.summary.model,
            prompt: SUMMARY_PROMPT(content, settings.summary.maxChars),
            stream: false,
            think: false,
          }),
          signal: controller.signal,
        })
        if (!response.ok) return undefined
        const body = await response.json() as { response?: unknown }
        return typeof body.response === 'string' ? body.response : undefined
      } catch {
        // No model, no summary: the first line still names the entry.
        return undefined
      } finally {
        clearTimeout(timer)
      }
    }
    : undefined
  void coordinator
  void runtime
  return new ColdIndexSync({
    debounceMs: settings.debounceMs,
    collect,
    markers,
    maxChars: settings.summary.maxChars,
    ...(summarize === undefined ? {} : { summarize }),
    write: entries => updateIndex(settings.targetPath.startsWith('~')
      ? join(homedir(), settings.targetPath.slice(1))
      : settings.targetPath, entries, {
      markers,
      maxDescription: settings.summary.maxChars,
      ...(summarize === undefined ? {} : { summarize }),
      // The handle column is what makes the index usable without a search
      // phrase: read Z011, type Z011, get that entry. Built from the live table
      // so a rewritten entry loses its old handle here in the same run.
      ...(shortIds === undefined ? {} : { handles: shortIds.handles() }),
    }),
  })
}

export function apply(rawContext: unknown, rawConfig: MnemonConfig | LiveHostConfig = {}): void {
  const ctx = rawContext as unknown as HostContextShape
  const config = plainHostConfig(rawConfig)
  const hostSettings = new ProfileMnemonSettings(ctx, rawConfig)
  registerMnemonSubagentTokenUsageProjection(ctx)
  const extensions = provideMemoryRuntime(ctx)
  const memoryPlugins = new MemoryPluginManagement(ctx, extensions, hostSettings)
  const pluginInstallation = new MemoryPluginInstallation(ctx)
  const effectiveConfig = (value: MnemonConfig) => memoryPlugins.resolveConfig(resolveConfig(value), value.memoryView ?? { entries: {} })
  const settings = hostSettings.register<MnemonConfig>('mnemon', PlainConfig, {
    base: config,
    applies: 'live',
    // Profile writes commit asynchronously. Check that the candidate composes
    // now, then build from the committed live references on volatile-update.
    validate: value => createRuntimeGraph(effectiveConfig(value), undefined, extensions).dispose(),
  })
  const runtime = new LiveMnemonRuntime(createRuntimeGraph(effectiveConfig(settings.get()), undefined, extensions), optionalWorkspaceRegistry(ctx), ctx.agents, extensions)
  runtime.useGitHubAuth(optionalGitHubAuth(ctx))
  // The automatic Git backup is one timer for the whole Host, not one per
  // graph: a settings write builds and disposes a throwaway graph to validate
  // itself, and a timer owned by a graph would be armed and dropped again on
  // every keystroke in the settings form.
  const autoBackup = new MnemonAutoBackupScheduler(runtime)
  runtime.useAutoBackup(() => autoBackup.snapshot())
  const resolved = runtime.config
  ctx.effect(() => hostSettings.onUpdated((namespace, value) => {
    if (namespace === memoryPlugins.settingsNamespace) {
      runtime.swap(createRuntimeGraph(effectiveConfig(settings.get()), undefined, extensions))
      return
    }
    if (namespace !== 'mnemon') return
    runtime.swap(createRuntimeGraph(effectiveConfig(value as MnemonConfig), undefined, extensions))
  }), 'dsh-tingfeng: live runtime settings')
  ctx.effect(() => memoryPlugins.start(), 'dsh-tingfeng: plugin graph settings')
  hostSettings.register('mnemon-ui', InteractionConfig, {
    base: resolveInteractionConfig(resolved.conversationInteraction),
    applies: 'live',
  })
  // 技能管理's settings: read at every turn and review, so a change applies at once.
  const skillSettings = hostSettings.register<ResolvedSkillsConfig>('mnemon-skills', SkillsConfig, {
    base: { ...DEFAULT_SKILLS_CONFIG },
    applies: 'live',
  })
  ctx.effect(() => {
    let disposed = false
    const migrate = (): void => {
      if (disposed) return
      void migrateLegacyDisplayMode(hostSettings).catch(error => {
        console.warn('dsh-tingfeng: could not persist the builtin displayMode migration', error)
      })
    }
    const unsubscribe = ctx.on('settings/document-updated', ((namespace: string) => {
      if (namespace === 'mnemon') migrate()
    }) as never)
    migrate()
    return () => { disposed = true; unsubscribe() }
  }, 'dsh-tingfeng: canonical displayMode migration')
  ctx.effect(() => {
    let disposed = false
    const loader = ctx.get('loader') as { await?(): Promise<unknown> } | undefined
    void Promise.resolve(loader?.await?.()).then(async () => {
      if (disposed) return
      const catalog = await memoryPlugins.catalog()
      if (disposed) return
      await hostSettings.importLegacy(catalog.entries.filter(entry => entry.roles.includes('source')).map(entry => entry.entryId))
    }).catch(error => { console.warn('dsh-tingfeng: could not recover retained legacy settings', error) })
    return () => { disposed = true }
  }, 'dsh-tingfeng: retained settings migration')
  const coordinator: MnemonSubagentCoordinator = new MnemonSubagentCoordinator(ctx.subagents, runtime, ctx, () => {
    const taskAgentModel = runtime.config.taskAgentModel
    if (taskAgentModel.mode !== 'fixed') return undefined
    const provider = taskAgentModel.provider?.trim()
    const model = taskAgentModel.model?.trim()
    if (provider === undefined || provider === '' || model === undefined || model === '') return undefined
    return { provider, model }
  }, () => runtime.config.runtimeMemory.maintenanceMaxTokens,
  (scope, signal, operation) => lifecycle.runRuntimeMaintenanceTask(scope, signal, operation))
  const lifecycle = new MnemonLifecycle(ctx, coordinator, runtime.config, runtime)
  const skills = new SkillEvolution({
    settings: () => skillSettings.get(),
    source: agent => skillsSourceFor(runtime, agent),
    runTask: (workspaceRoot, signal, operation, route) => lifecycle.runSkillTask(workspaceRoot, signal, operation, route),
    skillTask: (parent, label, prompt, schema, persona, signal) => coordinator.skillTask(parent, label, prompt, schema, persona, signal, taskRoute(parent)),
  })
  lifecycle.useSkillEvolution(skills)
  // Registered before the lifecycle root so teardown runs the other way round:
  // the timer stops first, and only then does the runtime it reads go away.
  ctx.effect(() => {
    const stop = autoBackup.start()
    return () => { stop() }
  }, 'dsh-tingfeng: automatic Git backup')
  ctx.effect(() => {
    const stop = lifecycle.start()
    return async () => {
      stop()
      skills.dispose()
      await coordinator.dispose()
      runtime.dispose()
    }
  }, 'dsh-tingfeng.lifecycle-root()')
  ctx.effect(() => {
    const loader = ctx.get('loader') as { await?(): Promise<unknown> } | undefined
    // Built per lifecycle root, so a profile that switches the feature off never
    // pays for a table and a test that never enables it never touches disk.
    const dataDir = createStorageRoot(resolved).effectiveDataDir()
    const shortIds = resolved.shortIds.enabled
      ? new ShortIdStore({
        prefix: resolved.shortIds.prefix,
        digits: resolved.shortIds.digits,
        directory: dataDir,
      })
      : undefined
    const index = coldIndexSync(resolved, dataDir, coordinator, runtime, shortIds)
    if (index !== undefined) {
      // Registered before the tools so teardown cancels the timer first, and
      // after the runtime it reads so teardown runs the other way round.
      ctx.effect(() => () => { index.dispose() }, 'dsh-tingfeng: cold-library index timer')
      // Build once at startup. `notify` only ever came from a write, so a profile
      // that installed the feature onto a library it already had would keep
      // showing a column of blanks until someone happened to write something —
      // and on a fresh install that can be days. Building the index is the step
      // an install owes the reader, so it runs without waiting for a write.
      //
      // `flush` rather than `notify`: there is no burst of edits to coalesce at
      // startup, and a quiet period would just postpone the very first index a
      // new install is waiting to see. Not awaited — a slow summarising model
      // must not hold up the host coming up.
      void index.flush().catch(() => {
        // A failed first build is not a reason to fail the start: the timer is
        // still armed by every later write, and the previous index stays valid.
      })
    }
    return registerTools(ctx, runtime, coordinator, extensions, loader?.await?.(), shortIds, index === undefined ? undefined : () => { index.notify() }, dataDir)
  }, 'dsh-tingfeng: Source tool lifecycle')
  registerCommands(ctx.commands, runtime, coordinator)
  registerGuidance(ctx, resolved)
  ctx.inject(['connection', 'webServer'], (webContext) => {
    // `inject` guarantees the service at runtime; retain the defensive guard
    // because HostContextShape also models profiles where it is absent.
    // Connection's RPC getter keeps its provider's injection scope. Carry
    // the explicitly injected server on our own Context so late registration
    // works without changing or restarting the shared Connection plugin.
    const connection = Context.is(webContext)
      ? webContext.extend({ webServer: webContext.get('webServer') }).connection
      : webContext.connection
    if (connection === undefined) return
    // The Starter updates through DSH's own plugin manager and profile, so a packaged
    // app's bundled pnpm serves it where no pnpm is on PATH.
    const versions = new VersionUpdateManager({
      mnemonCliPath: () => runtime.config.cliPath,
      bundleInstaller: () => ctx.get('pluginManager') as DshBundleInstaller | undefined,
      runningProfile: () => {
        const profile = ctx.get('profileContext') as { dir?: unknown; packageManager?: unknown } | undefined
        return typeof profile?.dir === 'string' ? { dir: profile.dir, packageManager: profile.packageManager !== undefined } : undefined
      },
      pluginCommand: () => dshPluginCommand(ctx.get('profileContext')),
    })
    const rpc = registerRpc(connection, runtime, lifecycle, versions, () => autoBackup.refresh(), () => hasNativeDirectoryPicker(ctx))
    const settings = registerSettingsRpc(connection, hostSettings)
    const view = registerViewRpc(connection, runtime, extensions, memoryPlugins, lifecycle, pluginInstallation)
    if (Context.is(webContext)) {
      new MnemonRemoteService(webContext, {
        ...rpc,
        settings,
        view: view.read,
        viewWrite: view.write,
        management: resolved.remoteAccess === 'trusted-host',
      })
    }
  })
}
