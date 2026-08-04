import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'core/index': 'src/core/index.ts',
    'adapters/index': 'src/adapters/index.ts',
    'health/index': 'src/health/index.ts',
    'oracle/index': 'src/oracle/index.ts',
    'simulate/index': 'src/simulate/index.ts',
    'bundle/index': 'src/bundle/index.ts',
    'watch/index': 'src/watch/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  treeshake: true,
})
