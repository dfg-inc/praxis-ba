import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// `product/` is intentionally NOT a pnpm-workspace member (see root
// pnpm-workspace.yaml) — its real VitePress build resolves
// `@praxis-ba/canon-graph` via a Vite `resolve.alias` in Plan 2 (design spec
// §13). Task 14 (VitePress data loaders) tests the loader files' pure core
// functions from THIS package's vitest run, importing them by relative path
// — so the same alias is set up here, scoped to this package only, purely so
// `product/.vitepress/loaders/*.data.ts`'s `@praxis-ba/canon-graph` import
// resolves under test. This does not touch product/'s own config/build.
export default defineConfig({
  resolve: {
    alias: {
      '@praxis-ba/canon-graph': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
    },
  },
});
