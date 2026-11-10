import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it, vi } from 'vitest'
import {
  CALENDAR_BOUNDS,
  CHAT_BOUNDS,
  DOCS_BOUNDS,
  DRIVE_BOUNDS,
  FORMS_BOUNDS,
  GMAIL_BOUNDS,
  LIST_HINT,
  PAGE_HINT,
  PEOPLE_BOUNDS,
  SLIDES_BOUNDS,
  TASKS_BOUNDS,
  TEXT_HINT
} from './bounds.js'
import { makeDomainRun } from './factory.js'

/**
 * A service that echoes one canned payload from every action it is asked for,
 * so a bound sees a payload of a known size whichever action name it is tested
 * under. `methods` records the params each call received.
 */
function captureService(payload: unknown, action = 'capture') {
  const methods = {
    call: vi.fn(
      async (_params: unknown): Promise<CallToolResult> => ({
        content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }]
      })
    )
  }
  class CaptureService {
    constructor(auth: unknown) {
      void auth
    }
    [action] = methods.call
  }
  return { CaptureService, methods }
}

function textOf(result: CallToolResult): string {
  const item = result.content[0]
  if (item.type !== 'text') throw new Error('expected text result')
  return item.text
}

const BIG = { body: 'b'.repeat(30_000), nextPageToken: 'page-2' }

describe('domain factory response bounds', () => {
  it('caps a bounded action at 20000 characters by default', async () => {
    const { CaptureService, methods } = captureService(BIG)
    const run = makeDomainRun(CaptureService, ['capture'], { bounds: { capture: { hint: TEXT_HINT } } })

    const text = textOf(await run({ action: 'capture' }))

    expect(text.length).toBeLessThanOrEqual(20_000)
    expect(JSON.parse(text)._truncation.truncated).toBe(true)
    expect(JSON.parse(text)._truncation.note).toContain('[Content truncated: showing')
    expect(methods.call).toHaveBeenCalledOnce()
  })

  it('raises the cap with max_chars and removes it with full', async () => {
    const { CaptureService } = captureService(BIG)
    const run = makeDomainRun(CaptureService, ['capture'], { bounds: { capture: {} } })

    const raised = JSON.parse(textOf(await run({ action: 'capture', max_chars: 100_000 })))
    expect(raised._truncation).toBeUndefined()
    expect(raised.body.length).toBe(30_000)

    const full = JSON.parse(textOf(await run({ action: 'capture', full: true })))
    expect(full).toEqual(BIG)
  })

  it('rejects a bad max_chars before calling the service', async () => {
    const { CaptureService, methods } = captureService(BIG)
    const run = makeDomainRun(CaptureService, ['capture'], { bounds: { capture: {} } })

    await expect(run({ action: 'capture', max_chars: 2_000_000 })).rejects.toThrow(/max_chars must be an integer/)
    expect(methods.call).not.toHaveBeenCalled()
  })

  it('never forwards the bound knobs to the service method', async () => {
    const { CaptureService, methods } = captureService({ ok: true })
    const run = makeDomainRun(CaptureService, ['capture'], { bounds: { capture: {} } })

    await run({ action: 'capture', max_chars: 500, full: false, fileId: 'f1' })

    expect(methods.call).toHaveBeenCalledWith({ fileId: 'f1' })
  })

  it('leaves an unbounded action on the same tool untouched, knob included', async () => {
    const { CaptureService, methods } = captureService(BIG, 'other')
    const run = makeDomainRun(CaptureService, ['capture', 'other'], { bounds: { capture: {} } })

    const text = textOf(await run({ action: 'other', max_chars: 500 }))
    expect(text).toBe(JSON.stringify(BIG))
    // The tool advertises the knobs, so an unbounded action must still not pass
    // them to a service that has no idea what they mean.
    expect(methods.call).toHaveBeenCalledWith({})
  })

  it('has no bound at all when the tool declares none', async () => {
    const { CaptureService } = captureService(BIG)
    const run = makeDomainRun(CaptureService, ['capture'])

    expect(textOf(await run({ action: 'capture', max_chars: 10 }))).toBe(JSON.stringify(BIG))
  })

  it('keeps a cursor in a truncated listing', async () => {
    const page = {
      events: Array.from({ length: 20 }, (_, index) => ({ id: `e${index}`, description: 'd'.repeat(2_000) })),
      nextPageToken: 'event-page-3'
    }
    const { CaptureService } = captureService(page)
    const run = makeDomainRun(CaptureService, ['capture'], {
      bounds: { capture: CALENDAR_BOUNDS.listEvents }
    })

    const parsed = JSON.parse(textOf(await run({ action: 'capture' })))

    expect(parsed._truncation.truncated).toBe(true)
    expect(parsed.nextPageToken).toBe('event-page-3')
  })
})

/**
 * One row per real bounded action: the default cap, the marker, and the escape
 * hatch are properties of the shipped policy, not of a hand-made fixture.
 */
const BOUNDED_ACTIONS: Array<[string, string, Record<string, { items?: number; hint?: string }>]> = [
  ['docs', 'getSuggestions', DOCS_BOUNDS],
  ['slides', 'getText', SLIDES_BOUNDS],
  ['slides', 'getMetadata', SLIDES_BOUNDS],
  ['slides', 'getImages', SLIDES_BOUNDS],
  ['slides', 'getSpeakerNotes', SLIDES_BOUNDS],
  ['gmail', 'get', GMAIL_BOUNDS],
  ['gmail', 'search', GMAIL_BOUNDS],
  ['gmail', 'listLabels', GMAIL_BOUNDS],
  ['gmail', 'modify', GMAIL_BOUNDS],
  ['gmail', 'modifyThread', GMAIL_BOUNDS],
  ['drive', 'search', DRIVE_BOUNDS],
  ['drive', 'getComments', DRIVE_BOUNDS],
  ['drive', 'findFolder', DRIVE_BOUNDS],
  ['chat', 'listSpaces', CHAT_BOUNDS],
  ['chat', 'findSpaceByName', CHAT_BOUNDS],
  ['chat', 'getMessages', CHAT_BOUNDS],
  ['chat', 'listThreads', CHAT_BOUNDS],
  ['calendar', 'listCalendars', CALENDAR_BOUNDS],
  ['calendar', 'listEvents', CALENDAR_BOUNDS],
  ['calendar', 'getEvent', CALENDAR_BOUNDS],
  ['calendar', 'findFreeTime', CALENDAR_BOUNDS],
  ['tasks', 'listTaskLists', TASKS_BOUNDS],
  ['tasks', 'listTasks', TASKS_BOUNDS],
  ['people', 'getUserProfile', PEOPLE_BOUNDS],
  ['people', 'getMe', PEOPLE_BOUNDS],
  ['people', 'getUserRelations', PEOPLE_BOUNDS],
  ['forms', 'get', FORMS_BOUNDS],
  ['forms', 'listResponses', FORMS_BOUNDS],
  ['forms', 'getResponse', FORMS_BOUNDS]
]

describe('shipped bound policy', () => {
  it.each(BOUNDED_ACTIONS)(
    '%s.%s caps by default, marks truncation and honours full',
    async (_tool, action, bounds) => {
      const items = bounds[action].items ?? 500
      const oversized =
        items === 500
          ? { body: 'b'.repeat(25_000) }
          : { items: Array.from({ length: items + 5 }, (_, index) => ({ id: `i${index}` })) }
      const { CaptureService } = captureService(oversized, action)
      const run = makeDomainRun(CaptureService, [action], { bounds })

      const bounded = JSON.parse(textOf(await run({ action })))
      expect(textOf(await run({ action })).length).toBeLessThanOrEqual(20_000)
      expect(bounded._truncation.truncated).toBe(true)
      expect(bounded._truncation.note).toMatch(
        /^\[Content truncated: showing (\d+) of (\d+) characters \((\d+) omitted\)\. /
      )
      if (items !== 500) {
        expect(bounded._truncation.omitted_items[0].total).toBe(items + 5)
        expect(bounded._truncation.omitted_items[0].returned).toBe(items)
      }

      const full = JSON.parse(textOf(await run({ action, full: true })))
      expect(full).toEqual(oversized)
    }
  )

  it('gives every paged action a pageToken hint and every unpaged one a full hint', () => {
    const paged = [
      'search',
      'listResponses',
      'getMessages',
      'listThreads',
      'listEvents',
      'listTasks',
      'listTaskLists',
      'getComments',
      'listSpaces'
    ]
    for (const bounds of [GMAIL_BOUNDS, FORMS_BOUNDS, CHAT_BOUNDS, CALENDAR_BOUNDS, TASKS_BOUNDS, DRIVE_BOUNDS]) {
      for (const [action, bound] of Object.entries(bounds)) {
        if (!paged.includes(action)) continue
        expect(bound.hint).toBe(PAGE_HINT)
        expect(bound.items).toBeUndefined()
      }
    }
    expect(SLIDES_BOUNDS.getImages.hint).toBe(LIST_HINT)
    expect(SLIDES_BOUNDS.getText.hint).toBe(TEXT_HINT)
  })
})
