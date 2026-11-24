import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  create: vi.fn(),
  valuesUpdate: vi.fn(),
  valuesAppend: vi.fn(),
  valuesClear: vi.fn(),
  batchUpdate: vi.fn()
}))

vi.mock('googleapis', () => ({
  google: {
    sheets: () => ({
      spreadsheets: {
        create: h.create,
        batchUpdate: h.batchUpdate,
        values: {
          update: h.valuesUpdate,
          append: h.valuesAppend,
          clear: h.valuesClear
        }
      }
    })
  }
}))

vi.mock('../../auth/credential-state.js', () => ({
  getAuth: () => ({ getAuthenticatedClient: async () => ({}) })
}))

import { AuthManager } from '../auth/AuthManager.js'
import { SheetsService } from './SheetsService.js'

const makeService = () => new SheetsService(new AuthManager())
const parse = (res: { content: Array<{ text: string }> }) => JSON.parse(res.content[0].text)

describe('SheetsService write actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates a spreadsheet with optional sheet tabs', async () => {
    h.create.mockResolvedValue({
      data: {
        spreadsheetId: 'sheet-1',
        spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
        properties: { title: 'Budget' },
        sheets: [{ properties: { sheetId: 0, title: 'Summary' } }, { properties: { sheetId: 1, title: 'Data' } }]
      }
    })

    const res = parse(await makeService().create({ title: 'Budget', sheetTitles: ['Summary', 'Data'] }))
    expect(h.create).toHaveBeenCalledWith({
      requestBody: {
        properties: { title: 'Budget' },
        sheets: [{ properties: { title: 'Summary' } }, { properties: { title: 'Data' } }]
      }
    })
    expect(res).toEqual({
      spreadsheetId: 'sheet-1',
      title: 'Budget',
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
      sheets: [
        { sheetId: 0, title: 'Summary' },
        { sheetId: 1, title: 'Data' }
      ]
    })
  })

  it('creates a spreadsheet without explicit sheetTitles and rejects empty title', async () => {
    h.create.mockResolvedValue({ data: { spreadsheetId: 'sheet-2' } })
    const ok = parse(await makeService().create({ title: 'Minimal' }))
    expect(h.create).toHaveBeenCalledWith({ requestBody: { properties: { title: 'Minimal' } } })
    expect(ok).toEqual({ spreadsheetId: 'sheet-2', title: 'Minimal', spreadsheetUrl: undefined, sheets: [] })

    const bad = parse(await makeService().create({ title: '' }))
    expect(bad.error).toContain('title must be a non-empty string')
  })

  it('updates a range and extracts ID from a Sheets URL', async () => {
    h.valuesUpdate.mockResolvedValue({
      data: {
        spreadsheetId: 'abc1234567890',
        updatedRange: 'Sheet1!A1:B2',
        updatedRows: 2,
        updatedColumns: 2,
        updatedCells: 4
      }
    })

    const res = parse(
      await makeService().updateRange({
        spreadsheetId: 'https://docs.google.com/spreadsheets/d/abc1234567890/edit',
        range: 'Sheet1!A1:B2',
        values: [
          ['A', 'B'],
          [1, 2]
        ],
        valueInputOption: 'RAW'
      })
    )
    expect(h.valuesUpdate).toHaveBeenCalledWith({
      spreadsheetId: 'abc1234567890',
      range: 'Sheet1!A1:B2',
      valueInputOption: 'RAW',
      requestBody: {
        values: [
          ['A', 'B'],
          [1, 2]
        ]
      }
    })
    expect(res.updatedCells).toBe(4)
  })

  it('appends rows with default options and handles non-array values', async () => {
    h.valuesAppend.mockResolvedValue({
      data: {
        tableRange: 'Sheet1!A1:B5',
        updates: { updatedRange: 'Sheet1!A6:B6', updatedRows: 1 }
      }
    })

    const res = parse(
      await makeService().appendRows({
        spreadsheetId: 'sheet-id',
        range: 'Sheet1!A:B',
        values: [['x', 42]]
      })
    )
    expect(h.valuesAppend).toHaveBeenCalledWith({
      spreadsheetId: 'sheet-id',
      range: 'Sheet1!A:B',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [['x', 42]] }
    })
    expect(res).toEqual({
      spreadsheetId: 'sheet-id',
      tableRange: 'Sheet1!A1:B5',
      updates: { updatedRange: 'Sheet1!A6:B6', updatedRows: 1 }
    })

    const badUpdate = parse(
      await makeService().updateRange({
        spreadsheetId: 'sheet-id',
        range: 'Sheet1!A1',
        values: 'bad' as unknown as unknown[][]
      })
    )
    expect(badUpdate.error).toContain('values must be a 2D array')

    const badAppend = parse(
      await makeService().appendRows({
        spreadsheetId: 'sheet-id',
        range: 'Sheet1!A1',
        values: 'bad' as unknown as unknown[][]
      })
    )
    expect(badAppend.error).toContain('values must be a 2D array')
  })

  it('clears a range and catches API failures', async () => {
    h.valuesClear.mockResolvedValue({ data: { clearedRange: 'Sheet1!A1:Z99' } })
    const res = parse(await makeService().clearRange({ spreadsheetId: 'sheet-id', range: 'Sheet1!A1:Z99' }))
    expect(res).toEqual({ spreadsheetId: 'sheet-id', clearedRange: 'Sheet1!A1:Z99' })

    h.valuesClear.mockRejectedValue(new Error('quota exceeded'))
    const err = parse(await makeService().clearRange({ spreadsheetId: 'sheet-id', range: 'Sheet1!A1' }))
    expect(err.error).toContain('quota exceeded')
  })

  it('adds a sheet tab and validates non-empty title', async () => {
    h.batchUpdate.mockResolvedValue({
      data: {
        replies: [{ addSheet: { properties: { sheetId: 42, title: 'Q4', index: 3 } } }]
      }
    })
    const res = parse(await makeService().addSheet({ spreadsheetId: 'sheet-id', title: 'Q4' }))
    expect(h.batchUpdate).toHaveBeenCalledWith({
      spreadsheetId: 'sheet-id',
      requestBody: { requests: [{ addSheet: { properties: { title: 'Q4' } } }] }
    })
    expect(res).toEqual({ spreadsheetId: 'sheet-id', sheetId: 42, title: 'Q4', index: 3 })

    const bad = parse(await makeService().addSheet({ spreadsheetId: 'sheet-id', title: '' }))
    expect(bad.error).toContain('title must be a non-empty string')

    h.batchUpdate.mockRejectedValue('boom')
    const err = parse(await makeService().addSheet({ spreadsheetId: 'sheet-id', title: 'Q5' }))
    expect(err.error).toBe('boom')
  })
})
