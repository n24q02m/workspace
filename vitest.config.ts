import { defineConfig } from 'vitest/config'

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
      // src/vendored/** is byte-identical upstream code (see NOTICE), not our
      // coverage target -- our code is src/tools/** and src/auth/**.
      exclude: ['node_modules/', 'build/', 'bin/', 'src/vendored/**'],
      // Global (aggregate) gate over our code -- fails `test:coverage` on
      // regression.
      thresholds: { lines: 95, functions: 95, branches: 95, statements: 95 }
    }
  }
})
