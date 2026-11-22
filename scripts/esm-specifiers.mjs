import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

// tsc copies every import specifier verbatim, and the vendored sources -- kept
// byte-identical with upstream, which bundles them -- import their neighbours
// without `.js`. Node ESM loads a relative specifier exactly as written: it adds
// no extension and loads no directory index. `main` loads the unbundled tree
// under build/, so each such specifier has to name the file it resolves to.
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bexport\s*\*\s*from\s*)(['"])(\.{1,2}\/[^'"]+)\2/g
const LOADABLE = /\.(?:js|mjs|cjs|json)$/

async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function loadableSpecifier(file, specifier) {
  const target = resolve(dirname(file), specifier)
  if (await isFile(`${target}.js`)) return `${specifier}.js`
  if (await isFile(join(target, 'index.js'))) return `${specifier}/index.js`
  return null
}

/**
 * Rewrite each extensionless relative import in the .js files under `dir` to the
 * file Node resolves it to, and return how many it rewrote. Throws, naming every
 * one, when an import resolves to no file: the build must not ship it.
 */
export async function addJsExtensions(dir) {
  const files = (await readdir(dir, { recursive: true })).filter((file) => file.endsWith('.js'))
  const unresolved = []
  let rewritten = 0
  for (const name of files) {
    const file = join(dir, name)
    const text = await readFile(file, 'utf8')
    const loadable = new Map()
    for (const [, , , specifier] of text.matchAll(SPECIFIER)) {
      if (LOADABLE.test(specifier) || loadable.has(specifier)) continue
      const resolved = await loadableSpecifier(file, specifier)
      if (resolved) loadable.set(specifier, resolved)
      else unresolved.push(`${file}: ${specifier}`)
    }
    if (loadable.size === 0) continue
    const next = text.replace(SPECIFIER, (match, lead, quote, specifier) => {
      if (!loadable.has(specifier)) return match
      rewritten += 1
      return `${lead}${quote}${loadable.get(specifier)}${quote}`
    })
    await writeFile(file, next)
  }
  if (unresolved.length > 0) {
    throw new Error(`relative imports that resolve to no file:\n${unresolved.join('\n')}`)
  }
  return rewritten
}
