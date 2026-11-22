import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import { parseNotice } from './scripts/sync-upstream.mjs'

// NOTICE sorts every file under src/vendored/. Only the files kept byte-identical
// with upstream stay out of the gate, since every sync overwrites them. Forked
// files carry our changes on top of upstream code, and the shims and files this
// repo added are ours: all of them count toward it like src/tools/** and src/auth/**.
const vendored = parseNotice(readFileSync(new URL('./NOTICE', import.meta.url), 'utf8'))

export default defineConfig({
  test: {
    // `.worktrees/**`: git worktree của repo này nằm trong chính repo, nên một
    // lần chạy từ gốc sẽ quét cả test của mọi branch đang mở ở worktree khác --
    // đo thật: 453 file / 4783 test / 428s thay vì 21 file, và kết quả gate
    // trộn code của branch khác vào.
    exclude: ['build/**', 'node_modules/**', 'bin/**', 'tests/live/**', 'tests/e2e*', '.worktrees/**'],
    coverage: {
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      // *.ts only -- `src/**` also matches the non-code doc fixtures under
      // src/docs/*.md, which the v8 provider then fails to parse as JS.
      include: ['src/**/*.ts'],
      exclude: ['node_modules/', 'build/', 'bin/', ...vendored.synced],
      // Global (aggregate) gate over our code -- fails `test:coverage` on
      // regression.
      thresholds: { lines: 95, functions: 95, branches: 95, statements: 95 }
    }
  }
})
