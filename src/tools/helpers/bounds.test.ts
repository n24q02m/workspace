import { describe, expect, it } from 'vitest'
import {
  boundResponseText,
  boundToolResult,
  DEFAULT_RESPONSE_CHARS,
  DEFAULT_RESPONSE_ITEMS,
  MAX_RESPONSE_CHARS,
  resolveResponseBudget,
  truncationNote,
  UNBOUNDED
} from './bounds.js'

const HINT = 'Pass full: true for the complete payload, or raise max_chars up to 100000.'

/** The text of one result part: narrows instead of asserting the shape. */
function textOf(result: { content: Array<{ type: string; text?: string }> }, index = 0): string {
  const item = result.content[index]
  if (item.type !== 'text' || typeof item.text !== 'string') throw new Error(`part ${index} is not text`)
  return item.text
}

const budgetOf = (spec: { chars?: number; items?: number } = {}) => resolveResponseBudget({}, spec)

describe('resolveResponseBudget', () => {
  it('defaults to 20000 characters and no item cap', () => {
    expect(budgetOf()).toEqual({ chars: DEFAULT_RESPONSE_CHARS, items: UNBOUNDED })
    expect(budgetOf()).toEqual({ chars: 20_000, items: Number.POSITIVE_INFINITY })
  })

  it('takes the item cap from the action spec', () => {
    expect(budgetOf({ items: DEFAULT_RESPONSE_ITEMS })).toEqual({
      chars: DEFAULT_RESPONSE_CHARS,
      items: DEFAULT_RESPONSE_ITEMS
    })
  })

  it('raises the character budget with max_chars', () => {
    expect(resolveResponseBudget({ max_chars: 50_000 })).toEqual({ chars: 50_000, items: UNBOUNDED })
    expect(resolveResponseBudget({ max_chars: MAX_RESPONSE_CHARS })).toEqual({
      chars: MAX_RESPONSE_CHARS,
      items: UNBOUNDED
    })
  })

  it('removes both bounds when full is true', () => {
    expect(resolveResponseBudget({ full: true }, { items: 50 })).toEqual({
      chars: UNBOUNDED,
      items: UNBOUNDED
    })
    // full wins over an explicit max_chars, so one flag always means "everything".
    expect(resolveResponseBudget({ full: true, max_chars: 100 }, { items: 50 })).toEqual({
      chars: UNBOUNDED,
      items: UNBOUNDED
    })
  })

  it.each([0, -1, 1.5, MAX_RESPONSE_CHARS + 1, Number.NaN, '20000'])('rejects max_chars %s', (value) => {
    expect(() => resolveResponseBudget({ max_chars: value })).toThrow(
      /max_chars must be an integer between 1 and 100000/
    )
  })

  it('ignores full when it is not exactly true', () => {
    expect(resolveResponseBudget({ full: 'yes' })).toEqual({ chars: DEFAULT_RESPONSE_CHARS, items: UNBOUNDED })
  })
})

describe('truncationNote', () => {
  it('names the kept size, the true size and the omitted count', () => {
    expect(truncationNote(1_000, 400, 'hint')).toBe(
      '[Content truncated: showing 400 of 1000 characters (600 omitted). hint]'
    )
  })

  it('never reports a negative omitted count', () => {
    expect(truncationNote(10, 20, 'hint')).toContain('(0 omitted)')
  })
})

describe('boundResponseText', () => {
  it('returns a payload inside the budget byte-for-byte', () => {
    const text = JSON.stringify({ id: 'm1', body: 'short' }, null, 2)
    expect(boundResponseText(text, budgetOf(), HINT)).toEqual({
      text,
      truncated: false,
      totalCharacters: text.length
    })
  })

  it('caps plain text at the default and appends the marker', () => {
    const text = 'x'.repeat(30_000)
    const bounded = boundResponseText(text, budgetOf(), HINT)

    expect(bounded.truncated).toBe(true)
    expect(bounded.totalCharacters).toBe(30_000)
    expect(bounded.text).toBe(
      `x${'x'.repeat(19_999)}\n\n[Content truncated: showing 20000 of 30000 characters (10000 omitted). ${HINT}]`
    )
  })

  it('raises the plain-text budget with max_chars', () => {
    const bounded = boundResponseText('y'.repeat(30_000), resolveResponseBudget({ max_chars: 25_000 }), HINT)

    expect(bounded.truncated).toBe(true)
    expect(bounded.text.startsWith('y'.repeat(25_000))).toBe(true)
    expect(bounded.text).toContain('showing 25000 of 30000 characters (5000 omitted)')
  })

  it('returns every character of plain text with full true', () => {
    const text = 'z'.repeat(120_000)
    expect(boundResponseText(text, resolveResponseBudget({ full: true }), HINT)).toEqual({
      text,
      truncated: false,
      totalCharacters: 120_000
    })
  })

  it('keeps a truncated JSON payload parseable and reports its true size', () => {
    const payload = { id: 'm1', body: 'b'.repeat(40_000) }
    const text = JSON.stringify(payload)

    const bounded = boundResponseText(text, budgetOf(), HINT)
    const parsed = JSON.parse(bounded.text)

    expect(parsed.id).toBe('m1')
    expect(bounded.text.length).toBeLessThanOrEqual(DEFAULT_RESPONSE_CHARS)
    expect(parsed._truncation.truncated).toBe(true)
    expect(parsed._truncation.total_characters).toBe(text.length)
    expect(parsed._truncation.note).toContain(`showing ${parsed._truncation.returned_characters} of ${text.length}`)
    expect(parsed._truncation.note).toContain(HINT)
  })

  it('preserves a pagination cursor while cutting a long page', () => {
    const payload = {
      messages: Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, body: 'b'.repeat(2_000) })),
      nextPageToken: `cursor-${'A'.repeat(500)}`
    }

    const parsed = JSON.parse(boundResponseText(JSON.stringify(payload), budgetOf(), HINT).text)

    expect(parsed.nextPageToken).toBe(payload.nextPageToken)
    expect(parsed._truncation.truncated).toBe(true)
  })

  it('never cuts a cursor even when it alone exceeds the budget', () => {
    const token = 'T'.repeat(30_000)
    const payload = { nextPageToken: token, events: [{ id: 'e1' }] }

    const bounded = boundResponseText(JSON.stringify(payload), budgetOf(), HINT)
    const parsed = JSON.parse(bounded.text)

    // The cursor wins over the character budget: dropping it would make the
    // rest of the listing unreachable, which is worse than a long response.
    expect(parsed.nextPageToken).toBe(token)
    expect(parsed._truncation.truncated).toBe(true)
    expect(parsed.events).toBeUndefined()
  })

  it('caps an unpaged listing by items and names what was dropped', () => {
    const payload = { comments: Array.from({ length: 120 }, (_, i) => ({ id: `c${i}` })) }

    const bounded = boundResponseText(JSON.stringify(payload), budgetOf({ items: 50 }), HINT)
    const parsed = JSON.parse(bounded.text)

    expect(bounded.truncated).toBe(true)
    expect(parsed.comments).toHaveLength(50)
    expect(parsed.comments[0]).toEqual({ id: 'c0' })
    expect(parsed._truncation.omitted_items).toEqual([{ path: '$.comments', returned: 50, total: 120 }])
    expect(parsed._truncation.note).toContain('[Content truncated: showing')
  })

  it('caps a top-level array by wrapping it with its cursor-free envelope', () => {
    const payload = Array.from({ length: 120 }, (_, i) => ({ id: `s${i}` }))

    const bounded = boundResponseText(JSON.stringify(payload), budgetOf({ items: 50 }), HINT)
    const parsed = JSON.parse(bounded.text)

    expect(parsed.items).toHaveLength(50)
    expect(parsed._truncation.omitted_items[0]).toEqual({ path: '$', returned: 50, total: 120 })
  })

  it('applies the item cap even when the payload is well inside the character budget', () => {
    const payload = { spaces: Array.from({ length: 60 }, (_, i) => ({ name: `spaces/${i}` })) }

    const bounded = boundResponseText(JSON.stringify(payload), budgetOf({ items: 50 }), HINT)

    expect(bounded.truncated).toBe(true)
    expect(JSON.parse(bounded.text).spaces).toHaveLength(50)
  })

  it('returns an unpaged listing whole with full true', () => {
    const payload = { comments: Array.from({ length: 120 }, (_, i) => ({ id: `c${i}` })) }
    const text = JSON.stringify(payload)

    expect(boundResponseText(text, resolveResponseBudget({ full: true }, { items: 50 }), HINT)).toEqual({
      text,
      truncated: false,
      totalCharacters: text.length
    })
  })

  it('cuts long strings inside kept items when the item cap alone is not enough', () => {
    const payload = {
      items: Array.from({ length: 100 }, (_, i) => ({ id: `i${i}`, blob: 'b'.repeat(4_000) }))
    }

    const bounded = boundResponseText(JSON.stringify(payload), budgetOf({ items: 100 }), HINT)
    const parsed = JSON.parse(bounded.text)

    // Every item survives; the long value inside each one is what gets cut,
    // which is the cheaper cut when the item count is the caller's useful unit.
    expect(bounded.text.length).toBeLessThanOrEqual(DEFAULT_RESPONSE_CHARS)
    expect(parsed._truncation.truncated).toBe(true)
    expect(parsed.items).toHaveLength(100)
    expect(parsed.items[0].id).toBe('i0')
    expect(parsed.items[0].blob.length).toBeLessThan(4_000)
    expect(parsed.items[0].blob).toContain('chars]')
  })

  it('drops items when even cut strings cannot fit the budget', () => {
    const payload = { items: Array.from({ length: 100 }, (_, i) => ({ id: `i${i}` })) }

    const bounded = boundResponseText(
      JSON.stringify(payload),
      resolveResponseBudget({ max_chars: 400 }, { items: 100 }),
      HINT
    )
    const parsed = JSON.parse(bounded.text)

    expect(bounded.text.length).toBeLessThanOrEqual(400)
    expect(parsed.items.length).toBeLessThan(100)
    expect(parsed._truncation.omitted_items[0].total).toBe(100)
  })

  it('keeps a tiny budget valid JSON by carrying whole root entries', () => {
    // 40 keys of 500 characters: no array to trim, and the deepest string cap
    // still leaves more than the 1,000-character budget.
    const payload = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, 'v'.repeat(500)]))
    const text = JSON.stringify(payload)

    const bounded = boundResponseText(text, resolveResponseBudget({ max_chars: 1_000 }), HINT)
    const parsed = JSON.parse(bounded.text)

    expect(bounded.truncated).toBe(true)
    expect(bounded.text.length).toBeLessThanOrEqual(1_000)
    expect(parsed.k0).toBeDefined()
    expect(Object.keys(parsed).length).toBeLessThan(41)
    expect(parsed._truncation.note).toContain(`of ${text.length} characters`)
  })

  it('hard-cuts text that is not JSON', () => {
    const text = `not json ${'n'.repeat(30_000)}`

    const bounded = boundResponseText(text, resolveResponseBudget({ max_chars: 500 }), HINT)

    expect(bounded.truncated).toBe(true)
    expect(bounded.text.length).toBeLessThanOrEqual(500 + 200)
    expect(bounded.text).toContain('[Content truncated: showing 500 of')
  })

  it('treats a broken JSON payload as plain text rather than failing', () => {
    const text = `{"content": [${'x'.repeat(30_000)}`

    const bounded = boundResponseText(text, budgetOf(), HINT)

    expect(bounded.truncated).toBe(true)
    expect(bounded.text.startsWith('{"content": [xxx')).toBe(true)
    expect(bounded.text).toContain('showing 20000 of 30013 characters')
  })

  it('treats a bare JSON scalar (a quoted string) as plain text', () => {
    const text = JSON.stringify('q'.repeat(30_000))

    const bounded = boundResponseText(text, budgetOf(), HINT)

    expect(bounded.truncated).toBe(true)
    expect(bounded.text.startsWith('"qqq')).toBe(true)
    expect(bounded.text).toContain('showing 20000 of 30002 characters')
  })

  it('treats a non-JSON error-ish string as plain text', () => {
    const bounded = boundResponseText(`error: ${'e'.repeat(25_000)}`, budgetOf(), HINT)

    expect(bounded.truncated).toBe(true)
    expect(bounded.text).toContain('showing 20000 of 25007 characters')
  })
})

describe('boundToolResult', () => {
  const bigText = JSON.stringify({ body: 'b'.repeat(30_000) })

  it('bounds every text part and leaves other parts alone', () => {
    const result = boundToolResult(
      {
        content: [
          { type: 'text' as const, text: bigText },
          { type: 'image' as const, data: 'AAAA', mimeType: 'image/png' },
          { type: 'text' as const, text: 'small' }
        ]
      },
      budgetOf(),
      HINT
    )

    expect(textOf(result, 0)).toContain('[Content truncated:')
    expect(result.content[1]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/png' })
    expect(textOf(result, 2)).toBe('small')
  })

  it('returns the same result object when nothing needs cutting', () => {
    const result = { content: [{ type: 'text' as const, text: '{"ok":true}' }] }
    expect(boundToolResult(result, budgetOf(), HINT)).toBe(result)
  })

  it('never cuts an error result', () => {
    const result = {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: 'x'.repeat(30_000) }) }],
      isError: true
    }
    expect(boundToolResult(result, budgetOf(), HINT)).toBe(result)
  })
})
