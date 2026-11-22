/**
 * The tsc output under build/ ships to npm, and `main` (build/src/init-server.js)
 * loads it as plain Node ESM: only bin/cli.mjs is bundled. Node ESM resolves a
 * relative specifier exactly as written -- it adds no `.js` and loads no
 * directory index -- so an extensionless import that tsc copies from the
 * vendored sources throws ERR_MODULE_NOT_FOUND the moment the module loads.
 * Reads the output of `bun run build`, which CI runs before the tests.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { addJsExtensions } from '../scripts/esm-specifiers.mjs'

const ROOT = resolve(__dirname, '..')
const BUILD = resolve(ROOT, 'build', 'src')
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bexport\s*\*\s*from\s*)(['"])(\.{1,2}\/[^'"]+)\1/g

function builtModules(): string[] {
  return readdirSync(BUILD, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.js'))
    .map((file) => resolve(BUILD, file))
}

describe('build output', () => {
  beforeAll(() => {
    if (!existsSync(BUILD)) {
      throw new Error(`build/src not found at ${BUILD} -- run \`bun run build\` before this test.`)
    }
  })

  it('names a file Node can load in every relative import', () => {
    const unresolved: string[] = []
    for (const file of builtModules()) {
      for (const [, , specifier] of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
        const target = resolve(dirname(file), specifier)
        if (!existsSync(target) || !statSync(target).isFile()) {
          unresolved.push(`${file.slice(ROOT.length + 1)}: ${specifier}`)
        }
      }
    }
    expect(unresolved).toEqual([])
  })

  // Node itself, not the runtime running vitest: Bun would resolve the
  // extensionless specifiers and pass. No argv entry, so main.js does not start.
  // 90s, not 30s: the import loads googleapis, about 2.5s on an idle machine but
  // measured at 34s while another test suite loaded the same machine.
  it('loads the server module under Node', { timeout: 90_000 }, () => {
    const url = pathToFileURL(resolve(BUILD, 'main.js')).href
    const out = execFileSync('node', ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    expect(out).toBe('')
  })
})

describe('addJsExtensions', () => {
  let dir = ''

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  function tree(files: Record<string, string>): string {
    dir = mkdtempSync(join(tmpdir(), 'esm-specifiers-'))
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), text)
    }
    return dir
  }

  it('names the file every extensionless relative import resolves to', async () => {
    const root = tree({
      'services/a.js': [
        "import { log } from '../utils/logger';",
        "import { x } from './b.js';",
        "export * from '../utils';",
        "import '../utils/side-effect';",
        "const lazy = () => import('./b');",
        "import { z } from 'zod';"
      ].join('\n'),
      'services/b.js': 'export const x = 1;',
      'utils/logger.js': 'export const log = 1;',
      'utils/side-effect.js': '',
      'utils/index.js': 'export const y = 1;'
    })

    expect(await addJsExtensions(root)).toBe(4)
    expect(readFileSync(join(root, 'services/a.js'), 'utf8')).toBe(
      [
        "import { log } from '../utils/logger.js';",
        "import { x } from './b.js';",
        "export * from '../utils/index.js';",
        "import '../utils/side-effect.js';",
        "const lazy = () => import('./b.js');",
        "import { z } from 'zod';"
      ].join('\n')
    )
    // a rerun over output it already rewrote (tsc --build skips an up-to-date emit) changes nothing
    expect(await addJsExtensions(root)).toBe(0)
  })

  it('fails, naming the file and the import, when an import resolves to no file', async () => {
    const root = tree({ 'services/a.js': "import { gone } from '../utils/gone';" })
    await expect(addJsExtensions(root)).rejects.toThrow(/services[\\/]a\.js: \.\.\/utils\/gone/)
  })
})
