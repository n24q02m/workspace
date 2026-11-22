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
import { setLoggingEnabled } from '../utils/logger.js'

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

describe('vendored SheetsService.getText rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders each tab as pipe-joined rows under the spreadsheet title', async () => {
    spreadsheetsGet.mockResolvedValue(metadataWithTabs(['Alpha', 'Beta']))
    valuesBatchGet.mockResolvedValue({
      data: { valueRanges: [{ values: [['a1', '', 'a3'], ['a4']] }, { values: [['b1']] }] }
    })

    const text = await getText({ spreadsheetId: 'sheet-1' })

    expect(text).toBe('Spreadsheet Title: Book\n\nSheet Name: Alpha\na1 |  | a3\na4\n\nSheet Name: Beta\nb1')
  })

  it('omits the title line when the spreadsheet has no title', async () => {
    spreadsheetsGet.mockResolvedValue({ data: { sheets: [{ properties: { title: 'Alpha' } }] } })
    valuesBatchGet.mockResolvedValue({ data: { valueRanges: [{ values: [['a1']] }] } })

    expect(await getText({ spreadsheetId: 'sheet-1' })).toBe('Sheet Name: Alpha\na1')
  })

  it('returns only the title for a spreadsheet whose metadata has no sheets field', async () => {
    spreadsheetsGet.mockResolvedValue({ data: { properties: { title: 'Book' } } })

    expect(await getText({ spreadsheetId: 'sheet-1' })).toBe('Spreadsheet Title: Book')
    expect(valuesBatchGet).not.toHaveBeenCalled()
  })

  it('skips tabs without a title instead of requesting an empty range', async () => {
    spreadsheetsGet.mockResolvedValue({
      data: {
        properties: { title: 'Book' },
        sheets: [{ properties: { title: 'Alpha' } }, { properties: {} }, {}, { properties: { title: '' } }]
      }
    })
    valuesBatchGet.mockResolvedValue({ data: { valueRanges: [{ values: [['a1']] }] } })

    const text = await getText({ spreadsheetId: 'sheet-1' })

    expect(valuesBatchGet).toHaveBeenCalledWith({ spreadsheetId: 'sheet-1', ranges: ["'Alpha'"] })
    expect(text).toBe('Spreadsheet Title: Book\n\nSheet Name: Alpha\na1')
  })

  it('requests metadata without grid data', async () => {
    spreadsheetsGet.mockResolvedValue(metadataWithTabs([]))

    await getText({ spreadsheetId: 'sheet-1' })

    expect(spreadsheetsGet).toHaveBeenCalledWith({ spreadsheetId: 'sheet-1', includeGridData: false })
  })

  it('extracts the spreadsheet id from a Google Sheets URL', async () => {
    spreadsheetsGet.mockResolvedValue(metadataWithTabs(['Alpha']))
    valuesBatchGet.mockResolvedValue({ data: { valueRanges: [{ values: [['a1']] }] } })

    await getText({ spreadsheetId: 'https://docs.google.com/spreadsheets/d/abc-123_XYZ/edit#gid=0' })

    expect(spreadsheetsGet).toHaveBeenCalledWith({ spreadsheetId: 'abc-123_XYZ', includeGridData: false })
    expect(valuesBatchGet).toHaveBeenCalledWith({ spreadsheetId: 'abc-123_XYZ', ranges: ["'Alpha'"] })
  })

  it('uses a bare spreadsheet id as given when it is not a URL', async () => {
    spreadsheetsGet.mockResolvedValue(metadataWithTabs([]))

    await getText({ spreadsheetId: 'plain-id' })

    expect(spreadsheetsGet).toHaveBeenCalledWith({ spreadsheetId: 'plain-id', includeGridData: false })
  })

  it('renders csv with quoting for commas, quotes and newlines', async () => {
    spreadsheetsGet.mockResolvedValue(metadataWithTabs(['Alpha']))
    valuesBatchGet.mockResolvedValue({
      data: { valueRanges: [{ values: [['plain', 'a,b', 'say "hi"', 'line1\nline2', ''], ['only']] }] }
    })

    const text = await getText({ spreadsheetId: 'sheet-1', format: 'csv' })

    expect(text).toBe('Spreadsheet Title: Book\n\nSheet Name: Alpha\nplain,"a,b","say ""hi""","line1\nline2",\nonly')
  })

  it('marks an empty tab and an unreadable tab differently in csv output', async () => {
    spreadsheetsGet.mockResolvedValue(metadataWithTabs(['Empty', 'Broken']))
    valuesBatchGet.mockRejectedValue(new Error('Unable to parse range'))
    valuesGet.mockImplementation(async (params: { range: string }) => {
      if (params.range === "'Broken'") throw new Error('boom')
      return { data: {} }
    })

    const text = await getText({ spreadsheetId: 'sheet-1', format: 'csv' })

    expect(text).toBe(
      'Spreadsheet Title: Book\n\nSheet Name: Empty\n(Empty sheet)\n\nSheet Name: Broken\n(Error reading sheet)'
    )
  })

  it('renders json as a pretty-printed object keyed by tab name without a title', async () => {
    spreadsheetsGet.mockResolvedValue(metadataWithTabs(['Alpha', 'Empty']))
    valuesBatchGet.mockResolvedValue({ data: { valueRanges: [{ values: [['a1', 'a2'], ['a3']] }, {}] } })

    const text = await getText({ spreadsheetId: 'sheet-1', format: 'json' })

    expect(text).toBe(JSON.stringify({ Alpha: [['a1', 'a2'], ['a3']], Empty: [] }, null, 2))
    expect(text).not.toContain('Spreadsheet Title')
  })

  it('honors max_chars as an explicit text budget', async () => {
    spreadsheetsGet.mockResolvedValue(metadataWithTabs(['Alpha']))
    valuesBatchGet.mockResolvedValue({ data: { valueRanges: [{ values: [['abcdefghij']] }] } })

    const text = await getText({ spreadsheetId: 'sheet-1', max_chars: 30 })

    const full = 'Spreadsheet Title: Book\n\nSheet Name: Alpha\nabcdefghij'
    expect(text.startsWith(full.slice(0, 30))).toBe(true)
    expect(text).toContain(`[Content truncated: showing 30 of ${full.length} characters (${full.length - 30} omitted).`)
  })

  it('names getRange as an escape hatch in the text truncation hint', async () => {
    spreadsheetsGet.mockResolvedValue(metadataWithTabs(['Alpha']))
    valuesBatchGet.mockResolvedValue({ data: { valueRanges: [{ values: [['x'.repeat(100)]] }] } })

    const text = await getText({ spreadsheetId: 'sheet-1', max_chars: 10 })

    expect(text).toContain(
      'Pass a larger max_chars (up to 100000), full:true, a narrower format, or getRange for one tab.'
    )
  })
})

describe('vendored SheetsService.getText batch fallback details', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const captureLog = () => {
    setLoggingEnabled(true)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    return {
      text: () => stderr.mock.calls.map((call) => String(call[0])).join(''),
      restore: () => {
        stderr.mockRestore()
        setLoggingEnabled(false)
      }
    }
  }

  it('falls back to per-tab reads when the batch response has no valueRanges', async () => {
    spreadsheetsGet.mockResolvedValue(metadataWithTabs(['Alpha', 'Beta']))
    valuesBatchGet.mockResolvedValue({ data: {} })
    valuesGet.mockImplementation(rowPerRange)

    const text = await getText({ spreadsheetId: 'sheet-1' })

    expect(valuesGet).toHaveBeenCalledTimes(2)
    expect(valuesGet).toHaveBeenCalledWith({ spreadsheetId: 'sheet-1', range: "'Alpha'" })
    expect(valuesGet).toHaveBeenCalledWith({ spreadsheetId: 'sheet-1', range: "'Beta'" })
    expect(text).toContain("Sheet Name: Alpha\n'Alpha' row")
    expect(text).toContain("Sheet Name: Beta\n'Beta' row")
  })

  it('treats a batch that returns more ranges than requested as failed', async () => {
    spreadsheetsGet.mockResolvedValue(metadataWithTabs(['Alpha']))
    valuesBatchGet.mockResolvedValue({ data: { valueRanges: [{ values: [['x']] }, { values: [['y']] }] } })
    valuesGet.mockImplementation(rowPerRange)

    const text = await getText({ spreadsheetId: 'sheet-1' })

    expect(valuesGet).toHaveBeenCalledTimes(1)
    expect(text).toContain("Sheet Name: Alpha\n'Alpha' row")
    expect(text).not.toContain('Sheet Name: Alpha\nx')
  })

  it('escapes quotes in tab names on the per-tab fallback too', async () => {
    spreadsheetsGet.mockResolvedValue(metadataWithTabs(["It's here", "a'b'c"]))
    valuesBatchGet.mockRejectedValue(new Error('batch down'))
    valuesGet.mockImplementation(rowPerRange)

    const text = await getText({ spreadsheetId: 'sheet-1' })

    expect(valuesGet).toHaveBeenCalledWith({ spreadsheetId: 'sheet-1', range: "'It''s here'" })
    expect(valuesGet).toHaveBeenCalledWith({ spreadsheetId: 'sheet-1', range: "'a''b''c'" })
    expect(text).toContain("Sheet Name: It's here\n'It''s here' row")
    expect(text).toContain("Sheet Name: a'b'c\n'a''b''c' row")
  })

  it('renders a tab the fallback read returned without values as an empty sheet', async () => {
    spreadsheetsGet.mockResolvedValue(metadataWithTabs(['Alpha']))
    valuesBatchGet.mockRejectedValue(new Error('batch down'))
    valuesGet.mockResolvedValue({ data: {} })

    expect(await getText({ spreadsheetId: 'sheet-1' })).toContain('Sheet Name: Alpha\n(Empty sheet)')
  })

  it('keeps every tab in a json fallback where all tabs are readable', async () => {
    spreadsheetsGet.mockResolvedValue(metadataWithTabs(['Alpha', 'Beta']))
    valuesBatchGet.mockRejectedValue(new Error('batch down'))
    valuesGet.mockImplementation(async (params: { range: string }) => ({
      data: { values: [[params.range]] }
    }))

    const parsed = JSON.parse(await getText({ spreadsheetId: 'sheet-1', format: 'json' }))

    expect(parsed).toEqual({ Alpha: [["'Alpha'"]], Beta: [["'Beta'"]] })
  })

  it('logs why the batch was abandoned and which tab failed', async () => {
    const log = captureLog()
    try {
      spreadsheetsGet.mockResolvedValue(metadataWithTabs(['Alpha', 'Broken']))
      valuesBatchGet.mockRejectedValue(new Error('Unable to parse range'))
      valuesGet.mockImplementation(async (params: { range: string }) => {
        if (params.range === "'Broken'") throw new Error('boom')
        return rowPerRange(params)
      })

      await getText({ spreadsheetId: 'sheet-1', format: 'json' })

      expect(log.text()).toContain('batchGet failed, falling back to per-sheet reads: Error: Unable to parse range')
      expect(log.text()).toContain('Error reading sheet Broken: Error: boom')
      expect(log.text()).toContain('Skipping sheet Broken in JSON output due to error')
    } finally {
      log.restore()
    }
  })

  it('names the length mismatch when it abandons a short batch', async () => {
    const log = captureLog()
    try {
      spreadsheetsGet.mockResolvedValue(metadataWithTabs(['Alpha', 'Beta']))
      valuesBatchGet.mockResolvedValue({ data: {} })
      valuesGet.mockImplementation(rowPerRange)

      await getText({ spreadsheetId: 'sheet-1' })

      expect(log.text()).toContain('batchGet returned 0 value ranges for 2 sheets')
    } finally {
      log.restore()
    }
  })
})

describe('vendored SheetsService.getText failures', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the Error message as a json error when the metadata read fails', async () => {
    spreadsheetsGet.mockRejectedValue(new Error('The caller does not have permission'))

    const parsed = JSON.parse(await getText({ spreadsheetId: 'sheet-1' }))

    expect(parsed).toEqual({ error: 'The caller does not have permission' })
    expect(valuesBatchGet).not.toHaveBeenCalled()
  })

  it('returns the text of a non-Error rejection as the json error', async () => {
    spreadsheetsGet.mockRejectedValue('quota gone')

    expect(JSON.parse(await getText({ spreadsheetId: 'sheet-1' }))).toEqual({ error: 'quota gone' })
  })

  it('rejects a non-integer max_chars before reading', async () => {
    const parsed = JSON.parse(await getText({ spreadsheetId: 'sheet-1', max_chars: 1.5 }))

    expect(parsed.error).toBe('max_chars must be an integer between 1 and 100000.')
    expect(spreadsheetsGet).not.toHaveBeenCalled()
  })
})

describe('vendored SheetsService.getRange', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads the requested range and returns it with its resolved A1 notation', async () => {
    const values = [
      ['a', 'b'],
      ['c', 'd']
    ]
    valuesGet.mockResolvedValue({ data: { range: 'Sheet1!A1:B2', values } })

    const parsed = JSON.parse(await getRange({ spreadsheetId: 'sheet-1', range: 'Sheet1!A1:B2' }))

    expect(valuesGet).toHaveBeenCalledWith({ spreadsheetId: 'sheet-1', range: 'Sheet1!A1:B2' })
    expect(parsed).toEqual({ range: 'Sheet1!A1:B2', values })
  })

  it('extracts the spreadsheet id from a Google Sheets URL', async () => {
    valuesGet.mockResolvedValue({ data: { range: 'Sheet1!A1', values: [['a']] } })

    await getRange({ spreadsheetId: 'https://docs.google.com/spreadsheets/d/abc-123_XYZ/edit', range: 'Sheet1!A1' })

    expect(valuesGet).toHaveBeenCalledWith({ spreadsheetId: 'abc-123_XYZ', range: 'Sheet1!A1' })
  })

  it('returns an empty values array when the range holds no data', async () => {
    valuesGet.mockResolvedValue({ data: { range: 'Sheet1!A1:B2' } })

    const parsed = JSON.parse(await getRange({ spreadsheetId: 'sheet-1', range: 'Sheet1!A1:B2' }))

    expect(parsed).toEqual({ range: 'Sheet1!A1:B2', values: [] })
  })

  it('keeps the largest whole-row prefix that fits max_chars', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => [`row-${i}`.padEnd(20, '.')])
    valuesGet.mockResolvedValue({ data: { range: 'S!A1:A12', values: rows } })
    const limit = 150
    const sizeOf = (n: number) => JSON.stringify({ range: 'S!A1:A12', values: rows.slice(0, n) }).length
    const expectedRows = Math.max(...rows.map((_, i) => i + 1).filter((n) => sizeOf(n) <= limit))

    const parsed = JSON.parse(await getRange({ spreadsheetId: 'sheet-1', range: 'S!A1:A12', max_chars: limit }))

    expect(expectedRows).toBeGreaterThan(0)
    expect(expectedRows).toBeLessThan(rows.length)
    expect(parsed.returned_rows).toBe(expectedRows)
    expect(parsed.values).toEqual(rows.slice(0, expectedRows))
    expect(parsed.returned_characters).toBe(sizeOf(expectedRows))
    expect(parsed.total_characters).toBe(sizeOf(rows.length))
    expect(parsed.total_rows).toBe(12)
    expect(parsed.truncated).toBe(true)
    expect(parsed.truncation_note).toBe(
      `[Content truncated: showing ${sizeOf(expectedRows)} of ${sizeOf(rows.length)} characters (${sizeOf(rows.length) - sizeOf(expectedRows)} omitted). ` +
        'Pass a larger max_chars (up to 100000), full:true, or narrow the range.]'
    )
  })

  it('returns zero rows when not even one row fits the budget', async () => {
    valuesGet.mockResolvedValue({ data: { range: 'S!A1:A2', values: [['x'.repeat(200)], ['y'.repeat(200)]] } })

    const parsed = JSON.parse(await getRange({ spreadsheetId: 'sheet-1', range: 'S!A1:A2', max_chars: 50 }))

    expect(parsed.truncated).toBe(true)
    expect(parsed.returned_rows).toBe(0)
    expect(parsed.values).toEqual([])
    expect(parsed.total_rows).toBe(2)
  })

  it('returns the payload untruncated when it is exactly as large as max_chars', async () => {
    const data = { range: 'S!A1', values: [['abc']] }
    valuesGet.mockResolvedValue({ data })
    const exact = JSON.stringify(data).length

    const text = await getRange({ spreadsheetId: 'sheet-1', range: 'S!A1', max_chars: exact })

    expect(text).toBe(JSON.stringify(data))
  })

  it('returns the Error message as a json error when the read fails', async () => {
    valuesGet.mockRejectedValue(new Error('Unable to parse range: Nope!A1'))

    const parsed = JSON.parse(await getRange({ spreadsheetId: 'sheet-1', range: 'Nope!A1' }))

    expect(parsed).toEqual({ error: 'Unable to parse range: Nope!A1' })
  })

  it('returns the text of a non-Error rejection as the json error', async () => {
    valuesGet.mockRejectedValue('rate limited')

    expect(JSON.parse(await getRange({ spreadsheetId: 'sheet-1', range: 'S!A1' }))).toEqual({
      error: 'rate limited'
    })
  })

  it('rejects an invalid max_chars before reading', async () => {
    const parsed = JSON.parse(await getRange({ spreadsheetId: 'sheet-1', range: 'S!A1', max_chars: 100_001 }))

    expect(parsed.error).toBe('max_chars must be an integer between 1 and 100000.')
    expect(valuesGet).not.toHaveBeenCalled()
  })
})

describe('vendored SheetsService.getMetadata', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const getMetadata = (spreadsheetId: string) =>
    new SheetsService(new AuthManager(['scope'])).getMetadata({ spreadsheetId }).then((res) => res.content[0].text)

  it('maps the spreadsheet and every tab to a compact summary', async () => {
    spreadsheetsGet.mockResolvedValue({
      data: {
        spreadsheetId: 'sheet-1',
        properties: { title: 'Book', locale: 'en_US', timeZone: 'Asia/Ho_Chi_Minh' },
        sheets: [
          { properties: { sheetId: 0, title: 'Alpha', index: 0, gridProperties: { rowCount: 100, columnCount: 26 } } },
          { properties: { sheetId: 7, title: 'Beta', index: 1, gridProperties: { rowCount: 5, columnCount: 3 } } }
        ]
      }
    })

    const parsed = JSON.parse(await getMetadata('sheet-1'))

    expect(spreadsheetsGet).toHaveBeenCalledWith({ spreadsheetId: 'sheet-1', includeGridData: false })
    expect(parsed).toEqual({
      spreadsheetId: 'sheet-1',
      title: 'Book',
      sheets: [
        { sheetId: 0, title: 'Alpha', index: 0, rowCount: 100, columnCount: 26 },
        { sheetId: 7, title: 'Beta', index: 1, rowCount: 5, columnCount: 3 }
      ],
      locale: 'en_US',
      timeZone: 'Asia/Ho_Chi_Minh'
    })
  })

  it('extracts the spreadsheet id from a Google Sheets URL', async () => {
    spreadsheetsGet.mockResolvedValue({ data: { spreadsheetId: 'abc-123_XYZ' } })

    await getMetadata('https://docs.google.com/spreadsheets/d/abc-123_XYZ/edit')

    expect(spreadsheetsGet).toHaveBeenCalledWith({ spreadsheetId: 'abc-123_XYZ', includeGridData: false })
  })

  it('omits fields the API did not return instead of failing', async () => {
    spreadsheetsGet.mockResolvedValue({ data: { spreadsheetId: 'sheet-1', sheets: [{}] } })

    const parsed = JSON.parse(await getMetadata('sheet-1'))

    expect(parsed).toEqual({ spreadsheetId: 'sheet-1', sheets: [{}] })
  })

  it('returns the Error message as a json error when the read fails', async () => {
    spreadsheetsGet.mockRejectedValue(new Error('Requested entity was not found.'))

    expect(JSON.parse(await getMetadata('sheet-1'))).toEqual({ error: 'Requested entity was not found.' })
  })

  it('returns the text of a non-Error rejection as the json error', async () => {
    spreadsheetsGet.mockRejectedValue('offline')

    expect(JSON.parse(await getMetadata('sheet-1'))).toEqual({ error: 'offline' })
  })
})
