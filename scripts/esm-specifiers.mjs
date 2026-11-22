import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'

// tsc copies every import specifier verbatim, and the vendored sources -- kept
// byte-identical with upstream, which bundles them -- import their neighbours
// without `.js`. Node ESM loads a relative specifier exactly as written: it adds
// no extension and loads no directory index. `main` loads the unbundled tree
// under build/, so each such specifier has to name the file it resolves to.

async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

function isRelative(specifier) {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../')
}

/**
 * The string literals that name a module in `text`: the specifier of each
 * import and export declaration and of each `import()` call with a literal
 * argument. Read from the syntax tree, so the same text in a comment or a string
 * is not one.
 */
function moduleSpecifiers(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const found = []
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      found.push(node.moduleSpecifier)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments
      if (argument && ts.isStringLiteralLike(argument)) found.push(argument)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found.map((literal) => ({ start: literal.getStart(source), end: literal.end, specifier: literal.text }))
}

/** The specifier naming the file Node should load, or null when there is none. */
async function loadableSpecifier(file, specifier) {
  const target = resolve(dirname(file), specifier)
  // `.`, `..` and `dir/` can only name a directory, never a file beside it.
  const directory =
    specifier === '.' || specifier === '..' ? `${specifier}/` : specifier.endsWith('/') ? specifier : null
  if (directory !== null) {
    return (await isFile(join(target, 'index.js'))) ? `${directory}index.js` : null
  }
  if (await isFile(target)) return specifier
  if (await isFile(`${target}.js`)) return `${specifier}.js`
  if (await isFile(join(target, 'index.js'))) return `${specifier}/index.js`
  return null
}

/**
 * Rewrite each relative import in the .js files under `dir` that does not name
 * a file to the file Node resolves it to, and return how many it rewrote.
 * Throws, naming each one once, when an import resolves to no file: the build
 * must not ship it.
 */
export async function addJsExtensions(dir) {
  const files = (await readdir(dir, { recursive: true })).filter((file) => file.endsWith('.js'))
  const unresolved = []
  let rewritten = 0
  for (const name of files) {
    const file = join(dir, name)
    const text = await readFile(file, 'utf8')
    const missing = new Set()
    let next = text
    // From the end, so each splice leaves the positions before it valid.
    for (const { start, end, specifier } of moduleSpecifiers(file, text).reverse()) {
      if (!isRelative(specifier)) continue
      const loadable = await loadableSpecifier(file, specifier)
      if (loadable === null) {
        missing.add(specifier)
      } else if (loadable !== specifier) {
        const quote = text[start]
        next = `${next.slice(0, start)}${quote}${loadable}${quote}${next.slice(end)}`
        rewritten += 1
      }
    }
    for (const specifier of [...missing].reverse()) unresolved.push(`${file}: ${specifier}`)
    if (next !== text) await writeFile(file, next)
  }
  if (unresolved.length > 0) {
    throw new Error(`relative imports that resolve to no file:\n${unresolved.join('\n')}`)
  }
  return rewritten
}
