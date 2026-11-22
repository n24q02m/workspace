import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { MAX_PAGE_SIZE, makeDomainRun, normalizePageSize } from './factory.js'

class CaptureService {
  constructor(auth: unknown) {
    void auth
  }
  list = async (params: unknown): Promise<CallToolResult> => ({
    content: [{ type: 'text', text: JSON.stringify(params) }]
  })

  write = async (params: unknown): Promise<CallToolResult> => ({
    content: [{ type: 'text', text: JSON.stringify(params) }]
  })
}
function textOf(result: CallToolResult): string {
  const item = result.content[0]
  if (item.type !== 'text') throw new Error('expected text result')
  return item.text
}

describe('pagination contracts', () => {
  it('defaults and clamps bounded list inputs', () => {
    expect(normalizePageSize(undefined, 'pageSize')).toBe(20)
    expect(normalizePageSize(0, 'pageSize')).toBe(1)
    expect(normalizePageSize(-10, 'pageSize')).toBe(1)
    expect(normalizePageSize(101, 'pageSize')).toBe(MAX_PAGE_SIZE)
  })

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, '20'])('rejects invalid %s', (value) => {
    expect(() => normalizePageSize(value, 'maxResults')).toThrow(/maxResults must be an integer/)
  })

  it('normalizes only the configured list action', async () => {
    const run = makeDomainRun(CaptureService, ['list', 'write'], {
      pagination: { list: 'pageSize' }
    })

    const listResult = await run({ action: 'list', pageSize: 500 })
    expect(JSON.parse(textOf(listResult))).toEqual({ pageSize: 100 })

    const writeResult = await run({ action: 'write', pageSize: 500 })
    expect(JSON.parse(textOf(writeResult))).toEqual({ pageSize: 500 })
  })
  it('rejects unknown actions before validating pagination fields', async () => {
    const run = makeDomainRun(CaptureService, ['list'], { pagination: { list: 'pageSize' } })
    await expect(run({ action: 'missing', pageSize: 1.5 })).rejects.toThrow(/Unknown action: missing/)
  })

  it('returns a validation error for invalid list input', async () => {
    const run = makeDomainRun(CaptureService, ['list'], { pagination: { list: 'pageSize' } })
    await expect(run({ action: 'list', pageSize: 1.5 })).rejects.toThrow(/pageSize must be an integer/)
  })
})

class ReplyService {
  constructor(auth: unknown) {
    void auth
  }
  reply = async (params: { text: string; isError?: boolean }): Promise<CallToolResult> => ({
    content: [{ type: 'text', text: params.text }],
    ...(params.isError === undefined ? {} : { isError: params.isError })
  })
}

describe('error payload contract', () => {
  const run = makeDomainRun(ReplyService, ['reply'], { bounds: { reply: { chars: 100 } } })

  it('flags a JSON object whose error field is a string', async () => {
    const text = JSON.stringify({ error: 'Calendar not found', details: 'notFound' })
    const result = await run({ action: 'reply', text })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe(text)
  })

  it('keeps an error payload whole on a bounded action', async () => {
    const text = JSON.stringify({ error: 'x'.repeat(500) })
    const result = await run({ action: 'reply', text })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe(text)
  })

  it.each([
    ['a success object', JSON.stringify({ id: 'e1', summary: 'Standup' })],
    ['a null error field', JSON.stringify({ error: null, items: [] })],
    ['an error field that is not a string', JSON.stringify({ error: { code: 404 } })],
    ['a JSON array', JSON.stringify([{ error: 'inside an item' }])],
    ['plain text that mentions an error', 'error: this line is document text'],
    ['text that looks like an error object but does not parse', '{"error": "unterminated']
  ])('leaves %s unflagged', async (_name, text) => {
    const result = await run({ action: 'reply', text })
    expect(result.isError).toBeUndefined()
  })

  it('keeps an isError the service already set', async () => {
    const text = JSON.stringify({ error: 'already flagged' })
    const result = await run({ action: 'reply', text, isError: true })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe(text)
  })
})
