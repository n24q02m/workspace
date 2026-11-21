import { describe, expect, it } from 'vitest'
import {
  boundJsonRows,
  boundText,
  DEFAULT_SHEETS_TEXT_LIMIT,
  FULL_TEXT_LIMIT,
  MAX_SHEETS_TEXT_LIMIT,
  resolveTextLimit,
  truncationNote
} from './textBounds.js'

describe('resolveTextLimit', () => {
  it('removes the bound when full is true, whatever max_chars says', () => {
    expect(resolveTextLimit(5, true)).toBe(FULL_TEXT_LIMIT)
  })

  it('uses the default budget when max_chars is absent', () => {
    expect(resolveTextLimit(undefined, undefined)).toBe(DEFAULT_SHEETS_TEXT_LIMIT)
    expect(resolveTextLimit(undefined, false)).toBe(DEFAULT_SHEETS_TEXT_LIMIT)
  })

  it('accepts any integer budget from 1 to the maximum', () => {
    expect(resolveTextLimit(1, undefined)).toBe(1)
    expect(resolveTextLimit(MAX_SHEETS_TEXT_LIMIT, false)).toBe(MAX_SHEETS_TEXT_LIMIT)
  })

  it.each([['500'], [1.5], [0], [MAX_SHEETS_TEXT_LIMIT + 1], [null]])('rejects max_chars %j', (value) => {
    expect(() => resolveTextLimit(value, undefined)).toThrow(/max_chars must be an integer between 1 and 100000/)
  })
})

describe('boundText', () => {
  it('returns text that fits unchanged', () => {
    expect(boundText('abc', 3, 'hint')).toEqual({
      text: 'abc',
      truncated: false,
      totalCharacters: 3,
      returnedCharacters: 3
    })
  })

  it('cuts text over the budget and ends it with the marker naming the true size', () => {
    const result = boundText('abcdef', 4, 'Pass full: true.')

    expect(result).toEqual({
      text: `abcd\n\n${truncationNote(6, 4, 'Pass full: true.')}`,
      truncated: true,
      totalCharacters: 6,
      returnedCharacters: 4
    })
    expect(result.text).toContain('showing 4 of 6 characters (2 omitted). Pass full: true.')
  })
})

describe('boundJsonRows', () => {
  it('returns the pretty-printed payload when it fits', () => {
    const data = { Sheet1: [['a', 1]] }

    expect(boundJsonRows(data, 10_000, 'hint')).toEqual({
      text: JSON.stringify(data, null, 2),
      truncated: false,
      totalCharacters: JSON.stringify(data, null, 2).length,
      returnedCharacters: JSON.stringify(data, null, 2).length,
      returnedRows: 1,
      totalRows: 1
    })
  })

  it('keeps whole rows in order, stops at the budget, and still emits valid JSON', () => {
    // Each compact row costs 204 characters against a 450-character row budget
    // (the limit minus the 512 reserved for the marker): two fit, the third does not.
    const row = ['x'.repeat(200)]
    const data = { First: [row, row, row], Second: [row, row] }
    const limit = 512 + 450

    const result = boundJsonRows(data, limit, 'hint')
    const parsed = JSON.parse(result.text)

    expect(result.truncated).toBe(true)
    expect(result.totalRows).toBe(5)
    expect(result.returnedRows).toBe(2)
    expect(parsed.First).toEqual([row, row])
    expect(parsed.Second).toBeUndefined()
    expect(parsed._truncation).toMatchObject({ truncated: true, returned_rows: 2, total_rows: 5 })
    expect(result.text.length).toBeLessThanOrEqual(limit)
  })

  it('moves on to the next sheet when an earlier sheet fits whole', () => {
    const row = ['y'.repeat(200)]
    const data = { First: [row], Second: [row, row, row, row, row] }

    const parsed = JSON.parse(boundJsonRows(data, 512 + 450, 'hint').text)

    expect(parsed.First).toEqual([row])
    expect(parsed.Second).toEqual([row])
  })

  it('keeps no rows rather than overrun a budget smaller than the reserved marker space', () => {
    const data = { Only: [['z'.repeat(50)]] }

    const result = boundJsonRows(data, 10, 'hint')

    expect(result.returnedRows).toBe(0)
    expect(JSON.parse(result.text).Only).toEqual([])
  })
})
