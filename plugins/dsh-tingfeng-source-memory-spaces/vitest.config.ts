import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
  test: { server: { deps: { inline: ['@deepseek-ai/dsh-client-ui-primitives', /dsh-tingfeng-source-/, /dsh-tingfeng-strategy-/, /dsh-tingfeng-provider-/] } } },
})
