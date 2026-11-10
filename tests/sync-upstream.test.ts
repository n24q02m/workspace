/**
 * The one thing worth testing about the sync script is what it refuses to do.
 *
 * Copying files is trivially reviewable in a diff; the failure that is NOT
 * reviewable is the script deciding, on a NOTICE it could not parse, that no file
 * is protected -- because the sync then succeeds, the report says "updated", and
 * the loss only surfaces later as a fixed bug that came back. So these tests pin
 * the refusals and the conflict classification, and nothing else.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain .mjs tooling script, no declarations by design
import { assertListedFilesExist, parseNotice, planSync } from '../scripts/sync-upstream.mjs'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const NOTICE = readFileSync(join(projectRoot, 'NOTICE'), 'utf8')

describe('parseNotice', () => {
  it('reads both lists out of the NOTICE this repo actually ships', () => {
    const lists = parseNotice(NOTICE)

    expect([...lists.forked].sort()).toEqual([
      'src/vendored/services/CalendarService.ts',
      'src/vendored/services/CalendarValidation.ts',
      'src/vendored/services/ChatService.ts',
      'src/vendored/services/DocsService.ts',
      'src/vendored/services/DriveService.ts',
      'src/vendored/services/SheetsService.ts',
      'src/vendored/utils/MimeHelper.ts',
      'src/vendored/utils/validation.ts'
    ])
    expect([...lists.replaced].sort()).toEqual([
      'src/vendored/auth/AuthManager.ts',
      'src/vendored/utils/logger.ts',
      'src/vendored/utils/paths.ts'
    ])
  })

  it('every path it reads is a file that exists, so the lists cannot drift unnoticed', () => {
    const lists = parseNotice(NOTICE)
    expect(() => assertListedFilesExist(lists, (p: string) => existsSync(join(projectRoot, p)))).not.toThrow()
  })

  it('refuses a NOTICE whose heading was renamed instead of parsing zero protected files', () => {
    const renamed = NOTICE.replace('## Files intentionally forked from upstream', '## Forked files')
    expect(() => parseNotice(renamed)).toThrow(/missing the "## Files intentionally forked/)
  })

  it('refuses a section that parses to an empty list', () => {
    // Strip every entry the section actually lists, so adding a fork cannot
    // quietly turn this test into one that strips nothing and still passes.
    const lists = parseNotice(NOTICE)
    let emptied = NOTICE
    for (const file of lists.forked) {
      emptied = emptied.replace(
        new RegExp(`^- ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*(?:\\n(?!- |## )[^\\n]*)*\\n?`, 'gm'),
        ''
      )
    }
    expect(emptied.length).toBeLessThan(NOTICE.length)
    expect(() => parseNotice(emptied)).toThrow(/lists no files/)
  })

  it('refuses a list naming a file that is no longer in the tree', () => {
    const lists = parseNotice(NOTICE)
    expect(() => assertListedFilesExist(lists, (p: string) => p !== 'src/vendored/utils/MimeHelper.ts')).toThrow(
      /MimeHelper\.ts/
    )
  })
})

describe('planSync', () => {
  const forked = new Set(['src/vendored/services/SheetsService.ts'])
  const replaced = new Set(['src/vendored/utils/paths.ts'])

  it('reports a changed fork as a conflict and carries no replacement text', () => {
    const plan = planSync({
      local: new Map([['src/vendored/services/SheetsService.ts', 'ours']]),
      upstream: new Map([['workspace-server/src/services/SheetsService.ts', 'theirs']]),
      forked,
      replaced
    })

    expect(plan).toEqual([{ path: 'src/vendored/services/SheetsService.ts', status: 'conflict' }])
  })

  it('updates a file that upstream changed and this repo never forked', () => {
    const plan = planSync({
      local: new Map([['src/vendored/services/DriveService.ts', 'old']]),
      upstream: new Map([['workspace-server/src/services/DriveService.ts', 'new']]),
      forked,
      replaced
    })

    expect(plan).toEqual([{ path: 'src/vendored/services/DriveService.ts', status: 'update', text: 'new' }])
  })

  it('leaves a shim alone even though upstream has a file at the same path', () => {
    // paths.ts is ours, not a fork: overwriting it would not conflict, it would
    // quietly pull gemini-cli's own directory layout back into the build.
    const plan = planSync({
      local: new Map([['src/vendored/utils/paths.ts', 'our shim']]),
      upstream: new Map([['workspace-server/src/utils/paths.ts', 'gemini-cli paths']]),
      forked,
      replaced
    })

    expect(plan).toEqual([])
  })

  it('says nothing happened when the file already matches upstream', () => {
    const plan = planSync({
      local: new Map([['src/vendored/services/DocsService.ts', 'same']]),
      upstream: new Map([['workspace-server/src/services/DocsService.ts', 'same']]),
      forked,
      replaced
    })

    expect(plan).toEqual([{ path: 'src/vendored/services/DocsService.ts', status: 'unchanged' }])
  })

  it('flags a vendored file upstream no longer has rather than deleting it', () => {
    const plan = planSync({
      local: new Map([['src/vendored/services/GoneService.ts', 'ours']]),
      upstream: new Map(),
      forked,
      replaced
    })

    expect(plan).toEqual([{ path: 'src/vendored/services/GoneService.ts', status: 'gone-upstream' }])
  })

  it('reports a new upstream service without copying it in', () => {
    const plan = planSync({
      local: new Map(),
      upstream: new Map([['workspace-server/src/services/NewService.ts', 'brand new']]),
      forked,
      replaced,
      reportNewIn: [{ local: 'src/vendored/services', upstream: 'workspace-server/src/services' }]
    })

    expect(plan).toEqual([{ path: 'workspace-server/src/services/NewService.ts', status: 'new-upstream' }])
    expect(plan[0]).not.toHaveProperty('text')
  })

  it('stays quiet about upstream utils this repo deliberately does not vendor', () => {
    const plan = planSync({
      local: new Map(),
      upstream: new Map([['workspace-server/src/utils/secure-browser-launcher.ts', 'gemini-cli plumbing']]),
      forked,
      replaced,
      reportNewIn: [{ local: 'src/vendored/services', upstream: 'workspace-server/src/services' }]
    })

    expect(plan).toEqual([])
  })
})
