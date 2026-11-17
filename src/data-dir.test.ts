import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { dataDir, PerPluginStore, setHomeDirForTesting } from '@n24q02m/hull/storage'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LEGACY_STORE_PLUGIN, STORE_PLUGIN } from './constants.js'
import {
  applyDataDirOverride,
  DATA_DIR_ENV,
  DATA_DIR_NAME,
  DataDirEscapeError,
  prepareDataDir,
  resolveBaseDir,
  resolveDataDir
} from './data-dir.js'
import { resetStoreMigrationForTesting } from './data-dir-migration.js'

// Platform-neutral absolute home: `resolve` makes it absolute on Windows too.
const HOME = resolve('/', 'home', 'user')

afterEach(() => {
  // `applyDataDirOverride` moves hull's process-wide home; put it back.
  applyDataDirOverride({})
})

describe('resolveDataDir', () => {
  it('names the directory hull uses for STORE_PLUGIN', () => {
    expect(DATA_DIR_NAME).toBe(`.${STORE_PLUGIN}`)
  })

  it('resolves the default data dir under the home directory', () => {
    expect(resolveBaseDir({}, HOME)).toBe(HOME)
    expect(resolveDataDir({}, HOME)).toBe(join(HOME, DATA_DIR_NAME))
  })

  it('honors an absolute DATA_DIR override', () => {
    const override = resolve('/', 'srv', 'workspace')
    expect(resolveDataDir({ [DATA_DIR_ENV]: override }, HOME)).toBe(join(override, DATA_DIR_NAME))
  })

  it('resolves a relative DATA_DIR override inside the base dir', () => {
    expect(resolveBaseDir({ [DATA_DIR_ENV]: 'state/workspace' }, HOME)).toBe(join(HOME, 'state', 'workspace'))
    expect(resolveDataDir({ [DATA_DIR_ENV]: './state/../state/workspace' }, HOME)).toBe(
      join(HOME, 'state', 'workspace', DATA_DIR_NAME)
    )
  })

  it('rejects a relative DATA_DIR override that escapes the base dir', () => {
    // Native separators, so the traversal is real on POSIX and on Windows; a
    // backslash path is only a traversal where the platform treats it as one.
    const hostile = ['..', '../..', '../../etc', 'state/../../..', join('..', '..', 'windows')]
    if (process.platform === 'win32') hostile.push('..\\..\\windows')

    for (const value of hostile) {
      expect(() => resolveDataDir({ [DATA_DIR_ENV]: value }, HOME), value).toThrow(DataDirEscapeError)
    }
  })

  it('rejects a DATA_DIR override containing a NUL byte', () => {
    expect(() => resolveDataDir({ [DATA_DIR_ENV]: `${HOME}\0evil` }, HOME)).toThrow(DataDirEscapeError)
  })

  it('falls back to the default when DATA_DIR is empty or whitespace', () => {
    expect(resolveDataDir({ [DATA_DIR_ENV]: '' }, HOME)).toBe(join(HOME, DATA_DIR_NAME))
    expect(resolveDataDir({ [DATA_DIR_ENV]: '   ' }, HOME)).toBe(join(HOME, DATA_DIR_NAME))
    expect(resolveDataDir({ [DATA_DIR_ENV]: undefined }, HOME)).toBe(join(HOME, DATA_DIR_NAME))
  })
})

describe('applyDataDirOverride', () => {
  it('moves hull’s per-plugin store under the override', () => {
    const override = resolve('/', 'srv', 'workspace')

    expect(applyDataDirOverride({ [DATA_DIR_ENV]: override })).toBe(override)
    expect(dataDir(STORE_PLUGIN)).toBe(join(override, DATA_DIR_NAME))
  })

  it('writes the credential store under the override', async () => {
    const base = mkdtempSync(join(tmpdir(), 'data-dir-store-'))
    try {
      applyDataDirOverride({ [DATA_DIR_ENV]: base })

      await new PerPluginStore(STORE_PLUGIN).save({ GOOGLE_OAUTH_CLIENT_ID: 'cid' })

      expect(existsSync(join(base, DATA_DIR_NAME, 'config.json'))).toBe(true)
      expect(await new PerPluginStore(STORE_PLUGIN).load()).toEqual({ GOOGLE_OAUTH_CLIENT_ID: 'cid' })
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('leaves hull alone when DATA_DIR is unset', () => {
    const before = dataDir(STORE_PLUGIN)
    expect(applyDataDirOverride({})).toBeNull()
    expect(dataDir(STORE_PLUGIN)).toBe(before)
  })
})

describe('prepareDataDir', () => {
  it('puts WORKSPACE_DATA_DIR in force before copying a pre-rename store forward', async () => {
    const base = mkdtempSync(join(tmpdir(), 'data-dir-prepare-'))
    const payload = { access_token: 'old-access-token', refresh_token: 'old-refresh-token' }
    try {
      // A store an earlier release wrote under the override base.
      setHomeDirForTesting(base)
      await new PerPluginStore(LEGACY_STORE_PLUGIN).save(payload)
      setHomeDirForTesting(null)
      resetStoreMigrationForTesting()
      vi.stubEnv(DATA_DIR_ENV, base)

      // No argument: startup reads the process environment.
      const report = await prepareDataDir()

      expect(report.migrated).toEqual([{ source: join(base, `.${LEGACY_STORE_PLUGIN}`), sub: null }])
      expect(existsSync(join(base, DATA_DIR_NAME, 'config.json'))).toBe(true)
      expect(await new PerPluginStore(STORE_PLUGIN).load()).toEqual(payload)
    } finally {
      vi.unstubAllEnvs()
      resetStoreMigrationForTesting()
      setHomeDirForTesting(null)
      rmSync(base, { recursive: true, force: true })
    }
  })
})
