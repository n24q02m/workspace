import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the auth shim so no real credentials are needed.
vi.mock('../../auth/credential-state.js', () => ({
  getAuth: () => ({ getAuthenticatedClient: async () => ({}) })
}))
// Mock googleapis to intercept the Sheets reads SheetsService.getText makes.
const spreadsheetsGet = vi.fn()
const valuesGet = vi.fn()
const valuesBatchGet = vi.fn()
vi.mock('googleapis', () => ({
  google: {
    sheets: () => ({
      spreadsheets: { get: spreadsheetsGet, values: { get: valuesGet, batchGet: valuesBatchGet } }
    })
  }
}))

import { SheetsService } from './SheetsService.js'
import { AuthManager } from '../auth/AuthManager.js'

const metadataWithTabs = (titles: string[]) => ({
  data: { properties: { title: 'Book' }, sheets: titles.map((title) => ({ properties: { title } })) }
})

const rowPerRange = async ({ range }: { range: string }) => ({ data: { values: [[`${range} row`]] } })

const getText = (args: {
  spreadsheetId: string
  format?: 'text' | 'csv' | 'json'
  max_chars?: number
  full?: boolean
}) => new SheetsService(new AuthManager(['scope'])).getText(args).then((res) => res.content[0].text)

const getRange = (args: { spreadsheetId: string; range: string; max_chars?: number; full?: boolean }) =>
  new SheetsService(new AuthManager(['scope'])).getRange(args).then((res) => res.content[0].text)

describe('vendored SheetsService.getText tab reads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads every tab in a single batchGet when the batch succeeds', async () => {
    spreadsheetsGet.mockResolvedValue(metadataWithTabs(['Alpha', 'Beta']))
    valuesBatchGet.mockResolvedValue({
      data: { valueRanges: [{ values: [['a1', 'a2']] }, { values: [['b1']] }] }
    })

    const text = await getText({ spreadsheetId: 'sheet-1' })

    expect(valuesBatchGet).toHaveBeenCalledTimes(1)
    expect(valuesBatchGet).toHaveBeenCalledWith({
      spreadsheetId: 'sheet-1',
      ranges: ["'Alpha'", "'Beta'"]
    })
    expect(valuesGet).not.toHaveBeenCalled()
    expect(text).toContain('Sheet Name: Alpha\na1 | a2')
    expect(text).toContain('Sheet Name: Beta\nb1')
  })

  it('renders a tab the batch returned empty as an empty sheet, not an error', async () => {
    // batchGet omits `values` entirely for a range with no data.
    spreadsheetsGet.mockResolvedValue(metadataWithTabs(['Alpha']))
    valuesBatchGet.mockResolvedValue({ data: { valueRanges: [{ range: "'Alpha'" }] } })

    expect(await getText({ spreadsheetId: 'sheet-1' })).toContain('Sheet Name: Alpha\n(Empty sheet)')
  })

  it('falls back to per-tab reads and keeps partial success when the batch rejects', async () => {
    // batchGet is all-or-nothing: one unreadable range loses every tab, which is
    // why the fallback exists. 3 tabs, 1 broken -> still 2 tabs of real data.
    spreadsheetsGet.mockResolvedValue(metadataWithTabs(['Alpha', 'Broken', 'Gamma']))
    valuesBatchGet.mockRejectedValue(new Error('Unable to parse range'))
    valuesGet.mockImplementation(async (params: { range: string }) => {
      if (params.range === "'Broken'") throw new Error('boom')
      return rowPerRange(params)
    })

    const text = await getText({ spreadsheetId: 'sheet-1' })

    expect(valuesGet).toHaveBeenCalledTimes(3)
    expect(text).toContain("Sheet Name: Alpha\n'Alpha' row")
    expect(text).toContain('Sheet Name: Broken\n(Error reading sheet)')
    expect(text).toContain("Sheet Name: Gamma\n'Gamma' row")
  })

  it('drops only the unreadable tab from json output', async () => {
    spreadsheetsGet.mockResolvedValue(metadataWithTabs(['Alpha', 'Broken']))
    valuesBatchGet.mockRejectedValue(new Error('Unable to parse range'))
    valuesGet.mockImplementation(async (params: { range: string }) => {
      if (params.range === "'Broken'") throw new Error('boom')
      return { data: { values: [['a1']] } }
    })

    const parsed = JSON.parse(await getText({ spreadsheetId: 'sheet-1', format: 'json' }))
    expect(parsed).toEqual({ Alpha: [['a1']] })
  })

  it('falls back rather than mis-mapping when batchGet returns the wrong number of ranges', async () => {
    // Tabs are matched to results by index, so a short response must not shift
    // Beta's rows onto Alpha (or hand Beta an empty sheet).
    spreadsheetsGet.mockResolvedValue(metadataWithTabs(['Alpha', 'Beta']))
    valuesBatchGet.mockResolvedValue({ data: { valueRanges: [{ values: [['a1']] }] } })
    valuesGet.mockImplementation(rowPerRange)

    const text = await getText({ spreadsheetId: 'sheet-1' })

    expect(valuesGet).toHaveBeenCalledTimes(2)
    expect(text).toContain("Sheet Name: Alpha\n'Alpha' row")
    expect(text).toContain("Sheet Name: Beta\n'Beta' row")
  })

  it('escapes a quote in a tab name instead of building an unparseable range', async () => {
    spreadsheetsGet.mockResolvedValue(metadataWithTabs(["It's here"]))
    valuesBatchGet.mockResolvedValue({ data: { valueRanges: [{ values: [['x']] }] } })

    await getText({ spreadsheetId: 'sheet-1' })

    expect(valuesBatchGet).toHaveBeenCalledWith({
      spreadsheetId: 'sheet-1',
      ranges: ["'It''s here'"]
    })
  })

  it('reads nothing and does not crash on a spreadsheet with no tabs', async () => {
    spreadsheetsGet.mockResolvedValue(metadataWithTabs([]))

    const text = await getText({ spreadsheetId: 'sheet-1' })

    expect(valuesBatchGet).not.toHaveBeenCalled()
    expect(valuesGet).not.toHaveBeenCalled()
    expect(text).toBe('Spreadsheet Title: Book')
  })
})

describe('vendored SheetsService text bounds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('truncates getText by default and reports the true size in the marker', async () => {
    spreadsheetsGet.mockResolvedValue(metadataWithTabs(['Alpha', 'Beta']))
    const rowA = ['a'.repeat(10_000)]
    const rowB = ['b'.repeat(10_000)]
    valuesBatchGet.mockResolvedValue({ data: { valueRanges: [{ values: [rowA] }, { values: [rowB] }] } })

    const text = await getText({ spreadsheetId: 'sheet-1' })

    expect(text.startsWith('Spreadsheet Title: Book')).toBe(true)
    expect(text.length).toBeLessThan(21_000)
    const marker = text.match(/\[Content truncated: showing (\d+) of (\d+) characters \((\d+) omitted\)\./)
    expect(marker).not.toBeNull()
    expect(Number(marker?.[1])).toBe(20_000)
    // The reported total is the full, untruncated rendering, not the visible tail.
    const fullLength = 'Spreadsheet Title: Book\n\nSheet Name: Alpha\n' + rowA[0] + "\n\nSheet Name: Beta\n" + rowB[0]
    expect(Number(marker?.[2])).toBe(fullLength.length)
    expect(Number(marker?.[3])).toBe(fullLength.length - 20_000)
  })

  it('returns the whole getText payload when full is true', async () => {
    spreadsheetsGet.mockResolvedValue(metadataWithTabs(['Alpha']))
    const row = ['c'.repeat(30_000)]
    valuesBatchGet.mockResolvedValue({ data: { valueRanges: [{ values: [row] }] } })

    const text = await getText({ spreadsheetId: 'sheet-1', full: true })

    expect(text).toContain(row[0])
    expect(text).not.toContain('[Content truncated:')
  })

  it('keeps truncated json output parseable and reports the real size', async () => {
    spreadsheetsGet.mockResolvedValue(metadataWithTabs(['Alpha']))
    const rows = Array.from({ length: 5 }, (_, i) => [`${i}`.padEnd(10_000, 'j')])
    valuesBatchGet.mockResolvedValue({ data: { valueRanges: [{ values: rows }] } })

    const parsed = JSON.parse(await getText({ spreadsheetId: 'sheet-1', format: 'json' }))

    expect(parsed._truncation.truncated).toBe(true)
    expect(parsed._truncation.total_characters).toBe(JSON.stringify({ Alpha: rows }, null, 2).length)
    expect(parsed._truncation.returned_rows).toBeLessThan(5)
    expect(parsed._truncation.returned_rows).toBe(parsed.Alpha.length)
    expect(parsed._truncation.note).toContain('[Content truncated: showing')
  })

  it('truncates getRange by whole rows and reports the true size', async () => {
    const rows = Array.from({ length: 400 }, (_, i) => [`row-${i}-`.padEnd(100, 'r')])
    valuesGet.mockResolvedValue({ data: { range: 'Sheet1!A1:A400', values: rows } })

    const parsed = JSON.parse(await getRange({ spreadsheetId: 'sheet-1', range: 'Sheet1!A1:A400' }))

    expect(parsed.truncated).toBe(true)
    expect(parsed.total_characters).toBe(JSON.stringify({ range: 'Sheet1!A1:A400', values: rows }).length)
    expect(parsed.total_rows).toBe(400)
    expect(parsed.returned_rows).toBe(parsed.values.length)
    expect(parsed.returned_rows).toBeLessThan(400)
    expect(parsed.truncation_note).toContain(`showing ${parsed.returned_characters} of ${parsed.total_characters}`)
  })

  it('returns every getRange row when the payload fits or full is requested', async () => {
    const rows = [['a', 'b'], ['c', 'd']]
    valuesGet.mockResolvedValue({ data: { range: 'Sheet1!A1:B2', values: rows } })

    const small = JSON.parse(await getRange({ spreadsheetId: 'sheet-1', range: 'Sheet1!A1:B2' }))
    expect(small).toEqual({ range: 'Sheet1!A1:B2', values: rows })

    const big = Array.from({ length: 400 }, (_, i) => [`row-${i}-`.padEnd(100, 'r')])
    valuesGet.mockResolvedValue({ data: { range: 'Sheet1!A1:A400', values: big } })
    const complete = JSON.parse(
      await getRange({ spreadsheetId: 'sheet-1', range: 'Sheet1!A1:A400', full: true })
    )
    expect(complete).toEqual({ range: 'Sheet1!A1:A400', values: big })
  })

  it('rejects a max_chars outside 1-100000 before reading', async () => {
    const text = await getText({ spreadsheetId: 'sheet-1', max_chars: 0 })

    expect(text).toContain('max_chars must be an integer between 1 and 100000')
    expect(spreadsheetsGet).not.toHaveBeenCalled()
  })
})
