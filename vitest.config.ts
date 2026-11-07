import { configDefaults, defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { clientCssPlugin } from './tsdown.config.ts'

export default defineConfig({
  // Compile the real class maps; JSDOM does not implement the browser CSS layout engine.
  plugins: [{ ...clientCssPlugin(false), enforce: 'pre' } as never],
  resolve: {
    alias: Object.entries({
      '@tingfeng/dsh-tingfeng/client': fileURLToPath(new URL('./src/client/extension-sdk.ts', import.meta.url)),
      'dsh-tingfeng-source-runtime/client': fileURLToPath(new URL('./plugins/dsh-tingfeng-source-runtime/src/client.ts', import.meta.url)),
      'dsh-tingfeng-source-documents/client': fileURLToPath(new URL('./plugins/dsh-tingfeng-source-documents/src/client.ts', import.meta.url)),
      'dsh-tingfeng-source-memory-spaces/client': fileURLToPath(new URL('./plugins/dsh-tingfeng-source-memory-spaces/src/client.ts', import.meta.url)),
      'dsh-tingfeng-source-memory-spaces/testing': fileURLToPath(new URL('./plugins/dsh-tingfeng-source-memory-spaces/src/testing.ts', import.meta.url)),
      'dsh-tingfeng-source-memory-spaces/native-cli': fileURLToPath(new URL('./plugins/dsh-tingfeng-source-memory-spaces/src/native-cli.ts', import.meta.url)),
      'dsh-tingfeng-source-memory-spaces/space-identity': fileURLToPath(new URL('./plugins/dsh-tingfeng-source-memory-spaces/src/space-identity.ts', import.meta.url)),
      'dsh-tingfeng-source-memory-spaces/provider-sdk': fileURLToPath(new URL('./plugins/dsh-tingfeng-source-memory-spaces/src/provider-sdk.ts', import.meta.url)),
      '@tingfeng/dsh-tingfeng/extension-sdk': fileURLToPath(new URL('./src/sdk/index.ts', import.meta.url)),
      '@tingfeng/dsh-tingfeng/contracts': fileURLToPath(new URL('./src/core/contracts/index.ts', import.meta.url)),
      '@tingfeng/dsh-tingfeng/testing': fileURLToPath(new URL('./src/sdk/testing.ts', import.meta.url)),
      'dsh-tingfeng-source-runtime/contracts': fileURLToPath(new URL('./plugins/dsh-tingfeng-source-runtime/src/contracts.ts', import.meta.url)),
      'dsh-tingfeng-source-documents/contracts': fileURLToPath(new URL('./plugins/dsh-tingfeng-source-documents/src/contracts.ts', import.meta.url)),
      'dsh-tingfeng-source-memory-spaces/contracts': fileURLToPath(new URL('./plugins/dsh-tingfeng-source-memory-spaces/src/contracts.ts', import.meta.url)),
      'dsh-tingfeng-source-runtime': fileURLToPath(new URL('./plugins/dsh-tingfeng-source-runtime/src/index.ts', import.meta.url)),
      'dsh-tingfeng-source-documents': fileURLToPath(new URL('./plugins/dsh-tingfeng-source-documents/src/index.ts', import.meta.url)),
      'dsh-tingfeng-source-skills/client': fileURLToPath(new URL('./plugins/dsh-tingfeng-source-skills/src/client.ts', import.meta.url)),
      'dsh-tingfeng-source-skills/contracts': fileURLToPath(new URL('./plugins/dsh-tingfeng-source-skills/src/contracts.ts', import.meta.url)),
      'dsh-tingfeng-source-skills': fileURLToPath(new URL('./plugins/dsh-tingfeng-source-skills/src/index.ts', import.meta.url)),
      'dsh-tingfeng-source-memory-spaces': fileURLToPath(new URL('./plugins/dsh-tingfeng-source-memory-spaces/src/index.ts', import.meta.url)),
      'dsh-tingfeng-strategy-default-three-tier/extension-sdk': fileURLToPath(new URL('./plugins/dsh-tingfeng-strategy-default-three-tier/src/extension-sdk.ts', import.meta.url)),
      'dsh-tingfeng-strategy-scoped': fileURLToPath(new URL('./plugins/dsh-tingfeng-strategy-scoped/src/index.ts', import.meta.url)),
      'dsh-tingfeng-strategy-light-context': fileURLToPath(new URL('./plugins/dsh-tingfeng-strategy-light-context/src/index.ts', import.meta.url)),
      'dsh-tingfeng-strategy-auto-capture': fileURLToPath(new URL('./plugins/dsh-tingfeng-strategy-auto-capture/src/index.ts', import.meta.url)),
      'dsh-tingfeng-strategy-default-three-tier': fileURLToPath(new URL('./plugins/dsh-tingfeng-strategy-default-three-tier/src/index.ts', import.meta.url)),
      'dsh-tingfeng-strategy-general': fileURLToPath(new URL('./plugins/dsh-tingfeng-strategy-general/src/index.ts', import.meta.url)),
      'dsh-tingfeng-provider-mnemon-native': fileURLToPath(new URL('./plugins/dsh-tingfeng-provider-mnemon-native/src/index.ts', import.meta.url)),
      'dsh-tingfeng-provider-openviking': fileURLToPath(new URL('./plugins/dsh-tingfeng-provider-openviking/src/index.ts', import.meta.url)),
      'dsh-tingfeng-provider-honcho': fileURLToPath(new URL('./plugins/dsh-tingfeng-provider-honcho/src/index.ts', import.meta.url)),
      'dsh-tingfeng-provider-mem0': fileURLToPath(new URL('./plugins/dsh-tingfeng-provider-mem0/src/index.ts', import.meta.url)),
      'dsh-tingfeng-provider-hindsight': fileURLToPath(new URL('./plugins/dsh-tingfeng-provider-hindsight/src/index.ts', import.meta.url)),
      'dsh-tingfeng-provider-holographic': fileURLToPath(new URL('./plugins/dsh-tingfeng-provider-holographic/src/index.ts', import.meta.url)),
      'dsh-tingfeng-provider-retaindb': fileURLToPath(new URL('./plugins/dsh-tingfeng-provider-retaindb/src/index.ts', import.meta.url)),
      'dsh-tingfeng-provider-byterover': fileURLToPath(new URL('./plugins/dsh-tingfeng-provider-byterover/src/index.ts', import.meta.url)),
      'dsh-tingfeng-provider-supermemory': fileURLToPath(new URL('./plugins/dsh-tingfeng-provider-supermemory/src/index.ts', import.meta.url)),
    }).map(([name, replacement]) => ({ find: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), replacement })),
    // Keep UI packages on Mnemon's React instance just as the browser bundle does.
    dedupe: ['react', 'react-dom'],
  },
  test: {
    environment: 'node',
    // These tests must execute outside the workspace, against packed artifacts.
    exclude: [...configDefaults.exclude, 'scripts/fixtures/**'],
    coverage: { enabled: false },
    server: {
      deps: {
        inline: ['@deepseek-ai/dsh-client-ui-primitives', /dsh-tingfeng-source-/, /dsh-tingfeng-strategy-/, /dsh-tingfeng-provider-/],
      },
    },
  },
})
