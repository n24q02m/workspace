import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

describe('vendored paths shim', () => {
  afterEach(() => {
    vi.doUnmock('node:fs')
    vi.resetModules()
  })

  it('roots PROJECT_ROOT at the package that ships this server', async () => {
    const { PROJECT_ROOT } = await import('./paths.js')

    expect(PROJECT_ROOT).toBe(repoRoot)
    expect(existsSync(path.join(PROJECT_ROOT, 'package.json'))).toBe(true)
  })

  it('falls back to the working directory instead of throwing when no package.json is found', async () => {
    // Upstream threw when its marker file was missing; this shim must not, since
    // a missing root only costs the optional debug log its base directory.
    vi.resetModules()
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>()
      const existsSync = () => false
      return { ...actual, existsSync, default: { ...actual, existsSync } }
    })

    const { PROJECT_ROOT } = await import('./paths.js')

    expect(PROJECT_ROOT).toBe(process.cwd())
  })
})
