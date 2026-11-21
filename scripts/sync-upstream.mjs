/**
 * Pull a newer revision of gemini-cli-extensions/workspace over the vendored tree.
 *
 *   node scripts/sync-upstream.mjs --ref v0.0.8 [--dry-run] [--no-test]
 *
 * Run by hand, on a cadence -- deliberately NOT wired into CI. A sync rewrites
 * code nobody reviewed in this repo's PR, so it needs a human between the copy
 * and the merge; a green pipeline that quietly moved vendored code would be the
 * opposite of the property `src/vendored/**` exists to give.
 *
 * WHAT MAY BE OVERWRITTEN IS DECIDED BY `NOTICE`, NOT BY THIS FILE. It lists the
 * files kept byte-identical (synced normally), the files that were forked on
 * purpose (reported as CONFLICT, never written), and the files that are this
 * repo's own -- shims sharing a path with upstream and files upstream never had
 * (skipped entirely). Hardcoding those
 * names here would give the repo two lists to keep in step, and the one that fell
 * behind would be discovered as a silently reverted bug fix.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const UPSTREAM_REPO = 'https://github.com/gemini-cli-extensions/workspace.git'

/**
 * Vendored directories and where they come from upstream.
 *
 * `reportNew` is on for services only. A service upstream added is a real signal
 * (a whole Workspace domain this server does not expose yet). The utils
 * directory, by contrast, is a hand-picked subset -- upstream also carries
 * `config.ts`, `open-wrapper.ts`, `secure-browser-launcher.ts` and
 * `tool-normalization.ts`, which are gemini-cli plumbing this repo deliberately
 * does not vendor. Listing those four on every run would train the reader to
 * skim past the section that is supposed to be rare.
 *
 * Nothing is ever copied in for a file this repo does not already vendor, in
 * either directory: a new file that no code imports is dead weight at best, and
 * at worst drags in an upstream dependency and breaks the build in a commit
 * labelled "sync".
 */
const VENDOR_DIRS = [
  { local: 'src/vendored/services', upstream: 'workspace-server/src/services', reportNew: true },
  { local: 'src/vendored/utils', upstream: 'workspace-server/src/utils', reportNew: false }
]

const SYNCED_HEADING = '## Files kept byte-identical with upstream'
const FORKED_HEADING = '## Files intentionally forked from upstream'
const REPLACED_HEADING = '## Files that replace an upstream file (ours, never synced)'
const ADDED_HEADING = '## Files this repo added (ours, no upstream counterpart)'

/**
 * Read the path lists out of NOTICE.
 *
 * Throws rather than returning what it managed to find. The failure that matters
 * is a NOTICE whose headings were renamed or whose bullets were reflowed: the
 * parse then yields an EMPTY list, which reads to the rest of this script as
 * "no file is protected" and overwrites every intentional fork -- silently, since
 * the copy itself succeeds and the loss only surfaces when the fixed bug returns.
 * So an empty list is treated as a broken file, never as an empty one.
 */
export function parseNotice(text) {
  const sections = { synced: SYNCED_HEADING, forked: FORKED_HEADING, replaced: REPLACED_HEADING, added: ADDED_HEADING }
  const out = {}

  for (const [key, heading] of Object.entries(sections)) {
    const start = text.indexOf(heading)
    if (start === -1) {
      throw new Error(`NOTICE is missing the "${heading}" section; refusing to sync without its file list.`)
    }
    const rest = text.slice(start + heading.length)
    const nextHeading = rest.indexOf('\n## ')
    const body = nextHeading === -1 ? rest : rest.slice(0, nextHeading)

    // Only the path matters; everything after it on the line is prose for humans.
    const paths = [...body.matchAll(/^- (\S+\.ts)\b/gm)].map((m) => m[1])
    if (paths.length === 0) {
      throw new Error(`NOTICE section "${heading}" lists no files; refusing to sync (see the note in NOTICE).`)
    }
    out[key] = new Set(paths)
  }

  return out
}

/** Fail on a list that names a file nobody kept in step with the tree. */
export function assertListedFilesExist(lists, exists) {
  const missing = [...lists.synced, ...lists.forked, ...lists.replaced, ...lists.added].filter((p) => !exists(p))
  if (missing.length > 0) {
    throw new Error(
      `NOTICE names ${missing.length} file(s) that are not in the tree: ${missing.join(', ')}. ` +
        'Fix NOTICE first -- a list that has drifted cannot be trusted to say what may be overwritten.'
    )
  }
}

/**
 * Decide what happens to every vendored file, without touching anything.
 *
 * `local` and `upstream` are maps of repo-relative path -> file contents; `forked`,
 * `replaced` and `added` are the NOTICE lists. Split out from the I/O so the
 * interesting half is testable without a network clone.
 */
export function planSync({ local, upstream, forked, replaced, added = new Set(), reportNewIn = [] }) {
  const plan = []

  for (const [path, localText] of local) {
    // Ours either way: a replaced file must not be overwritten by its namesake, and
    // an added file would otherwise be reported "gone upstream" -- read as a prompt
    // to delete it.
    if (replaced.has(path) || added.has(path)) continue
    const upstreamPath = upstreamPathFor(path)
    if (upstreamPath === null) continue

    const upstreamText = upstream.get(upstreamPath)
    if (upstreamText === undefined) {
      plan.push({ path, status: 'gone-upstream' })
    } else if (upstreamText === localText) {
      plan.push({ path, status: 'unchanged' })
    } else if (forked.has(path)) {
      plan.push({ path, status: 'conflict' })
    } else {
      plan.push({ path, status: 'update', text: upstreamText })
    }
  }

  for (const dir of reportNewIn) {
    for (const upstreamPath of upstream.keys()) {
      if (dirname(upstreamPath) !== dir.upstream) continue
      const localPath = `${dir.local}/${upstreamPath.split('/').pop()}`
      if (!local.has(localPath)) plan.push({ path: upstreamPath, status: 'new-upstream' })
    }
  }

  return plan.sort((a, b) => a.path.localeCompare(b.path) || a.status.localeCompare(b.status))
}

function upstreamPathFor(localPath) {
  const dir = VENDOR_DIRS.find((d) => localPath.startsWith(`${d.local}/`))
  return dir ? `${dir.upstream}/${localPath.slice(dir.local.length + 1)}` : null
}

function parseArgs(argv) {
  const args = { ref: 'main', dryRun: false, runTest: true }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ref') args.ref = argv[++i]
    else if (argv[i] === '--dry-run') args.dryRun = true
    else if (argv[i] === '--no-test') args.runTest = false
    else throw new Error(`Unknown argument: ${argv[i]}`)
  }
  if (!args.ref) throw new Error('--ref needs a value (a tag, branch or commit).')
  return args
}

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(res.stderr || res.stdout || '').trim()}`)
  }
  return res.stdout.trim()
}

/**
 * Shallow-fetch one revision into a temp clone.
 *
 * `fetch <ref>` rather than `clone --branch <ref>`, because --branch takes a tag
 * or branch but not a commit -- and pinning a sync to a commit is the case where
 * being able to reproduce it exactly matters most.
 *
 * autocrlf is turned OFF for this clone, and that is load-bearing rather than
 * tidy. Upstream ships no `.gitattributes`, so on a Windows machine (where git's
 * system config sets `autocrlf=true`) the checkout rewrites every line ending to
 * CRLF while this repo's own `.gitattributes` pins LF. Every single vendored file
 * then compares as changed: the report reads "14 changed" when upstream changed
 * nothing, and a real run rewrites the whole vendored tree in an encoding that
 * fails `bun run check` and destroys the byte-identity `src/vendored/**` exists
 * for. Measured, not hypothesised -- it is what the first dry run of this script
 * did.
 */
function checkoutUpstream(ref) {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-upstream-'))
  git(['init', '--quiet'], dir)
  git(['config', 'core.autocrlf', 'false'], dir)
  git(['config', 'core.eol', 'lf'], dir)
  git(['remote', 'add', 'origin', UPSTREAM_REPO], dir)
  git(['fetch', '--depth', '1', '--quiet', 'origin', ref], dir)
  git(['checkout', '--quiet', 'FETCH_HEAD'], dir)
  return { dir, sha: git(['rev-parse', 'HEAD'], dir) }
}

function readTree(root, dirs, filter) {
  const files = new Map()
  for (const dir of dirs) {
    const abs = join(root, dir)
    if (!existsSync(abs)) continue
    for (const name of readdirSync(abs)) {
      if (!name.endsWith('.ts') || !filter(name)) continue
      files.set(`${dir}/${name}`, readFileSync(join(abs, name), 'utf8'))
    }
  }
  return files
}

function report(plan, ref, sha, dryRun) {
  const order = ['conflict', 'update', 'new-upstream', 'gone-upstream', 'unchanged']
  const label = {
    conflict: 'CONFLICT     ',
    update: dryRun ? 'WOULD UPDATE ' : 'UPDATED      ',
    'new-upstream': 'NEW UPSTREAM ',
    'gone-upstream': 'GONE UPSTREAM',
    unchanged: 'unchanged    '
  }

  console.log(`\nUpstream ${UPSTREAM_REPO}\n  ref ${ref} -> ${sha}\n`)
  for (const status of order) {
    for (const entry of plan.filter((e) => e.status === status)) {
      console.log(`  ${label[status]}  ${entry.path}`)
    }
  }

  const counts = Object.fromEntries(order.map((s) => [s, plan.filter((e) => e.status === s).length]))
  console.log(
    `\n  ${counts.update} changed, ${counts.conflict} conflicting, ${counts['new-upstream']} new upstream, ` +
      `${counts['gone-upstream']} gone upstream, ${counts.unchanged} unchanged\n`
  )

  if (counts.conflict > 0) {
    console.log(
      'The conflicting files are forked on purpose (see NOTICE). Diff each one against the\n' +
        'upstream revision above and merge by hand; nothing was written to them.\n'
    )
  }
  return counts
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const lists = parseNotice(readFileSync(join(projectRoot, 'NOTICE'), 'utf8'))
  assertListedFilesExist(lists, (p) => existsSync(join(projectRoot, p)))

  // `*.test.ts` next to a vendored file is ours (NOTICE says so) and has no
  // upstream counterpart to sync from.
  const local = readTree(
    projectRoot,
    VENDOR_DIRS.map((d) => d.local),
    (name) => !name.endsWith('.test.ts')
  )

  const { dir, sha } = checkoutUpstream(args.ref)
  try {
    const upstream = readTree(
      dir,
      VENDOR_DIRS.map((d) => d.upstream),
      (name) => !name.endsWith('.test.ts')
    )

    const plan = planSync({
      local,
      upstream,
      forked: lists.forked,
      replaced: lists.replaced,
      added: lists.added,
      reportNewIn: VENDOR_DIRS.filter((d) => d.reportNew)
    })

    if (!args.dryRun) {
      for (const entry of plan.filter((e) => e.status === 'update')) {
        writeFileSync(join(projectRoot, entry.path), entry.text)
      }
    }

    const counts = report(plan, args.ref, sha, args.dryRun)

    if (counts.update > 0 && !args.dryRun && args.runTest) {
      console.log('Running the test suite over the synced tree...\n')
      const res = spawnSync('bun', ['run', 'test'], {
        cwd: projectRoot,
        stdio: 'inherit',
        shell: process.platform === 'win32'
      })
      if (res.status !== 0) {
        console.error('\nTests failed after the sync. Review the diff before committing anything.')
        return 1
      }
    }

    // Conflicts are the reason a human runs this, so they set the exit code: a
    // wrapper that ignores them would reintroduce exactly the silent overwrite
    // this script is built to prevent.
    return counts.conflict > 0 ? 1 : 0
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Guarded so the pure helpers above can be imported by tests without cloning.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`sync-upstream: ${err.message}`)
      process.exit(1)
    })
}
