import viteConfig from './vite.config'
import { fileURLToPath } from 'node:url'
import { mergeConfig, defineConfig } from 'vitest/config'

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'node',
      root: fileURLToPath(new URL('./', import.meta.url)),
      exclude: ['**/node_modules/**', '**/.worktrees/**', '**/dist/**'],
      setupFiles: [
        'src/assets/scripts/OpenChart/DiagramEditor/InterfacePlugins/PowerEditPlugin/PowerEditPlugin.testing.setup.ts',
      ],
    },
  }),
)
