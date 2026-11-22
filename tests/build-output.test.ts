/**
 * The tsc output under build/ ships to npm, and `main` (build/src/init-server.js)
 * loads it as plain Node ESM: only bin/cli.mjs is bundled. Node ESM resolves a
 * relative specifier exactly as written -- it adds no `.js` and loads no
 * directory index -- so an extensionless import that tsc copies from the
 * vendored sources throws ERR_MODULE_NOT_FOUND the moment the module loads.
 * Reads the output of `bun run build`, which CI runs before the tests.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { addJsExtensions } from '../scripts/esm-specifiers.mjs'

const ROOT = resolve(__dirname, '..')
const BUILD = resolve(ROOT, 'build', 'src')

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

  // Every module, not only main.js: init-server.js (`main`) and create-server.js
  // load main.js through `import()`, which a static walk from main.js never meets.
  // The child is `node` from PATH and must be Node itself: under `bun --bun run`
  // that name is Bun, which resolves extensionless specifiers and would pass.
  // No argv entry, so main.js does not start. stdout carries only the result:
  // a module that prints on import would break the MCP stdio transport.
  // 90s, not 30s: the imports load googleapis, about 2.5s on an idle machine but
  // measured at 34s while another test suite loaded the same machine.
  it('loads every module under Node', { timeout: 90_000 }, () => {
    const urls = builtModules().map((file) => pathToFileURL(file).href)
    expect(urls.map((url) => url.slice(url.lastIndexOf('/') + 1))).toEqual(
      expect.arrayContaining(['init-server.js', 'create-server.js', 'main.js'])
    )
    const script = [
      'const failures = []',
      "if (process.versions.bun) failures.push('the child runs under Bun, not Node')",
      `for (const url of ${JSON.stringify(urls)}) {`,
      '  try { await import(url) } catch (error) { failures.push(`${url}: ${error.code} ${error.message.split("\\n")[0]}`) }',
      '}',
      'process.stdout.write(JSON.stringify(failures))',
      'process.exit(0)'
    ].join('\n')
    const out = execFileSync('node', ['--input-type=module', '-e', script], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    expect(JSON.parse(out)).toEqual([])
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

  it('rewrites import syntax only, leaving the same text in a comment or a string alone', async () => {
    const root = tree({
      'services/a.js': [
        "/** @example import { thing } from './not-a-module' */",
        'const message = "cannot read from \'./b\'";',
        "import { x } from './b';"
      ].join('\n'),
      'services/b.js': 'export const x = 1;'
    })

    expect(await addJsExtensions(root)).toBe(1)
    expect(readFileSync(join(root, 'services/a.js'), 'utf8')).toBe(
      [
        "/** @example import { thing } from './not-a-module' */",
        'const message = "cannot read from \'./b\'";',
        "import { x } from './b.js';"
      ].join('\n')
    )
  })

  it('resolves directory specifiers, template-literal imports and a comment before the specifier', async () => {
    const root = tree({
      'pkg/a.js': [
        "import { here } from '.';",
        "import { up } from '..';",
        "import { u } from './utils/';",
        'const lazy = () => import(`./b`);',
        "import { c } from /* c */ './b';"
      ].join('\n'),
      'index.js': 'export const up = 1;',
      'pkg/index.js': 'export const here = 1;',
      // A file beside the directory must not win over `.`, `..` or a specifier that ends in `/`.
      'pkg.js': 'export const here = 0;',
      'pkg/utils.js': 'export const u = 0;',
      'pkg/utils/index.js': 'export const u = 1;',
      'pkg/b.js': 'export const c = 1;'
    })

    expect(await addJsExtensions(root)).toBe(5)
    expect(readFileSync(join(root, 'pkg/a.js'), 'utf8')).toBe(
      [
        "import { here } from './index.js';",
        "import { up } from '../index.js';",
        "import { u } from './utils/index.js';",
        'const lazy = () => import(`./b.js`);',
        "import { c } from /* c */ './b.js';"
      ].join('\n')
    )
  })

  it('leaves an import that already names an existing file as written, whatever its extension', async () => {
    const root = tree({
      'a.js': "import './style.css';\nimport data from './data.json';",
      'style.css': '',
      'data.json': '{}'
    })

    expect(await addJsExtensions(root)).toBe(0)
    expect(readFileSync(join(root, 'a.js'), 'utf8')).toBe("import './style.css';\nimport data from './data.json';")
  })

  it('fails on an import that names a missing file with its extension', async () => {
    const root = tree({ 'services/a.js': "import { gone } from './gone.js';" })
    await expect(addJsExtensions(root)).rejects.toThrow(/services[\\/]a\.js: \.\/gone\.js/)
  })

  it('names an unresolved import once, however often the file imports it', async () => {
    const root = tree({ 'a.js': "import { g } from './gone';\nconst lazy = () => import('./gone');" })

    const error = await addJsExtensions(root).then(
      () => null,
      (reason: Error) => reason
    )
    expect(error?.message.match(/\.\/gone/g)).toHaveLength(1)
  })
})
