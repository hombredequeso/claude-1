import { configDefaults, defineConfig, mergeConfig } from 'vitest/config'

// export default defineConfig({
//   test: {
//     reporters: [['json', { stdout: true }]],
//   },
// });

export default mergeConfig(configDefaults, defineConfig({
  test: {
    reporters: [['json', { stdout: true }]],
    watch: false
  },
}))
