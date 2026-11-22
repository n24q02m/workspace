import { describe, expect, it } from 'vitest'
import {
  calendarIdSchema,
  emailArraySchema,
  emailSchema,
  extractDocumentId,
  folderNameSchema,
  gmailAttachmentSchema,
  googleDocumentIdSchema,
  googleWorkspaceUrlSchema,
  iso8601DateTimeSchema,
  pageSizeSchema,
  searchQuerySchema,
  ValidationError,
  validateDateTime,
  validateDocumentId,
  validateEmail
} from './validation.js'

const BAD_DATETIME = 'Invalid ISO 8601 datetime format. Expected format: YYYY-MM-DDTHH:mm:ss[.sss][Z|±HH:mm]'

/** Messages of the issues a schema reports for a value; empty when the value is valid. */
const messagesFor = (schema: { safeParse: (v: unknown) => any }, value: unknown): string[] => {
  const result = schema.safeParse(value)
  return result.success ? [] : result.error.issues.map((issue: { message: string }) => issue.message)
}

describe('emailSchema', () => {
  it.each(['a@example.com', 'first.last+tag@sub.example.org'])('accepts %s', (email) => {
    expect(emailSchema.parse(email)).toBe(email)
  })

  it.each(['plain', '', 'a@b', '@example.com', 'a b@example.com'])('rejects %j', (value) => {
    expect(messagesFor(emailSchema, value)).toEqual(['Invalid email format'])
  })
})

describe('emailArraySchema', () => {
  it('accepts a single address or a list of addresses', () => {
    expect(emailArraySchema.parse('a@example.com')).toBe('a@example.com')
    expect(emailArraySchema.parse(['a@example.com', 'b@example.com'])).toEqual(['a@example.com', 'b@example.com'])
    expect(emailArraySchema.parse([])).toEqual([])
  })

  it('rejects a list containing an invalid address', () => {
    expect(messagesFor(emailArraySchema, ['a@example.com', 'nope'])).toEqual(['Invalid email format'])
  })

  it('rejects values that are neither a string nor a list', () => {
    expect(emailArraySchema.safeParse(42).success).toBe(false)
    expect(emailArraySchema.safeParse(null).success).toBe(false)
  })
})

describe('gmailAttachmentSchema', () => {
  it('accepts an absolute path with an optional filename and mimeType', () => {
    const input = { filePath: '/tmp/report.pdf', filename: 'Q1 report.pdf', mimeType: 'application/pdf' }
    expect(gmailAttachmentSchema.parse(input)).toEqual(input)
  })

  it('accepts a path alone', () => {
    expect(gmailAttachmentSchema.parse({ filePath: '/tmp/report.pdf' })).toEqual({ filePath: '/tmp/report.pdf' })
  })

  it('accepts empty-string filename and mimeType (the service falls back to path-derived defaults)', () => {
    const input = { filePath: '/tmp/report.pdf', filename: '', mimeType: '' }
    expect(gmailAttachmentSchema.parse(input)).toEqual(input)
  })

  it('rejects a relative path', () => {
    expect(messagesFor(gmailAttachmentSchema, { filePath: 'reports/q1.pdf' })).toEqual([
      'filePath must be an absolute path'
    ])
  })

  it('rejects a missing filePath', () => {
    expect(gmailAttachmentSchema.safeParse({ filename: 'x.pdf' }).success).toBe(false)
  })
})

describe('iso8601DateTimeSchema', () => {
  it.each([
    '2024-01-15T10:30:00Z',
    '2024-01-15T10:30:00-05:00',
    '2024-01-15T10:30:00+07:00',
    '2024-01-15T10:30:00.000Z',
    '2024-01-15T10:30:00.123+01:00',
    '2024-02-29T00:00:00Z',
    '2000-02-29T00:00:00Z',
    '0000-02-29T00:00:00Z',
    '2024-04-30T10:00:00+07:00',
    // The written date is checked, not the UTC date: these fall on 02-28 and 03-01 in UTC.
    '2026-03-01T00:30:00+14:00',
    '2026-02-28T23:30:00-12:00'
  ])('accepts %s', (value) => {
    expect(iso8601DateTimeSchema.parse(value)).toBe(value)
  })

  it.each([
    ['no timezone', '2024-01-15T10:30:00'],
    ['no seconds', '2024-01-15T10:30Z'],
    ['space separator', '2024-01-15 10:30:00Z'],
    ['two-digit milliseconds', '2024-01-15T10:30:00.12Z'],
    ['date only', '2024-01-15'],
    ['offset without colon', '2024-01-15T10:30:00+0700'],
    ['trailing text', '2024-01-15T10:30:00Z!'],
    ['empty string', '']
  ])('rejects a value with %s', (_label, value) => {
    expect(messagesFor(iso8601DateTimeSchema, value)).toEqual([BAD_DATETIME])
  })

  it.each([
    ['month 13', '2024-13-15T10:30:00Z'],
    ['day 32', '2024-01-32T10:30:00Z'],
    ['hour 25', '2024-01-15T25:00:00Z'],
    ['minute 61', '2024-01-15T10:61:00Z'],
    ['second 60', '2024-01-15T10:30:60Z']
  ])('rejects a well-formed timestamp that Date.parse cannot read (%s)', (_label, value) => {
    expect(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)).toBe(true)
    expect(Number.isNaN(Date.parse(value))).toBe(true)
    expect(messagesFor(iso8601DateTimeSchema, value)).toEqual([BAD_DATETIME])
  })

  it.each([
    ['February 30', '2026-02-30T10:00:00Z'],
    ['February 29 in a common year', '2025-02-29T00:00:00Z'],
    ['February 29 in a century that is not a leap year', '2100-02-29T00:00:00Z'],
    ['April 31 with an offset', '2024-04-31T10:00:00+07:00'],
    ['November 31 with milliseconds', '2023-11-31T23:59:59.999-05:00'],
    ['February 30 whose UTC date is a real day', '2026-02-30T00:30:00+14:00']
  ])('rejects a date that does not exist even though Date.parse rolls it over (%s)', (_label, value) => {
    expect(Number.isNaN(Date.parse(value))).toBe(false)
    expect(messagesFor(iso8601DateTimeSchema, value)).toEqual([BAD_DATETIME])
  })

  it('rejects a non-string value', () => {
    expect(iso8601DateTimeSchema.safeParse(1705314600000).success).toBe(false)
    expect(iso8601DateTimeSchema.safeParse(new Date()).success).toBe(false)
  })
})

describe('googleDocumentIdSchema', () => {
  it('accepts letters, digits, hyphens and underscores', () => {
    expect(googleDocumentIdSchema.parse('1aB_c-D2')).toBe('1aB_c-D2')
  })

  it.each(['', 'has space', 'a/b', 'a.b', 'id!'])('rejects %j', (value) => {
    expect(messagesFor(googleDocumentIdSchema, value)).toEqual([
      'Invalid document ID format. Document IDs should only contain letters, numbers, hyphens, and underscores'
    ])
  })
})

describe('googleWorkspaceUrlSchema', () => {
  it.each([
    'https://docs.google.com/document/d/abc123/edit',
    'https://drive.google.com/file/d/abc_123-x/view',
    'https://sheets.google.com/spreadsheets/d/abc123',
    'https://slides.google.com/presentation/d/abc123/edit'
  ])('accepts %s', (url) => {
    expect(googleWorkspaceUrlSchema.parse(url)).toBe(url)
  })

  it.each([
    'http://docs.google.com/document/d/abc123',
    'https://mail.google.com/mail/d/abc123',
    'https://docs.google.com/document/abc123',
    'https://evil.example.com/document/d/abc123',
    'docs.google.com/document/d/abc123'
  ])('rejects %s', (url) => {
    expect(messagesFor(googleWorkspaceUrlSchema, url)).toEqual(['Invalid Google Workspace URL format'])
  })
})

describe('folderNameSchema', () => {
  it('accepts an ordinary name, spaces and unicode', () => {
    expect(folderNameSchema.parse('Q1 Reports')).toBe('Q1 Reports')
    expect(folderNameSchema.parse('Báo cáo')).toBe('Báo cáo')
  })

  it('accepts a name of exactly 255 characters and rejects 256', () => {
    expect(folderNameSchema.safeParse('a'.repeat(255)).success).toBe(true)
    expect(messagesFor(folderNameSchema, 'a'.repeat(256))).toEqual(['Folder name too long (max 255 characters)'])
  })

  it('rejects an empty name', () => {
    expect(messagesFor(folderNameSchema, '')).toEqual(['Folder name cannot be empty'])
  })

  it.each(['<', '>', ':', '"', '/', '\\', '|', '?', '*', '\x00', '\x1F'])('rejects a name containing %j', (char) => {
    expect(messagesFor(folderNameSchema, `a${char}b`)).toEqual(['Folder name contains invalid characters'])
  })
})

describe('calendarIdSchema', () => {
  it('accepts "primary" and an email address', () => {
    expect(calendarIdSchema.parse('primary')).toBe('primary')
    expect(calendarIdSchema.parse('team@example.com')).toBe('team@example.com')
  })

  it('rejects anything else', () => {
    expect(calendarIdSchema.safeParse('secondary').success).toBe(false)
    expect(calendarIdSchema.safeParse('').success).toBe(false)
  })
})

describe('searchQuerySchema', () => {
  it('leaves a plain query untouched', () => {
    expect(searchQuerySchema.parse('quarterly report')).toBe('quarterly report')
  })

  it('escapes single quotes', () => {
    expect(searchQuerySchema.parse("it's")).toBe("it\\'s")
  })

  it('escapes double quotes so an exact phrase stays searchable', () => {
    expect(searchQuerySchema.parse('"exact phrase"')).toBe('\\"exact phrase\\"')
  })

  it('escapes backslashes', () => {
    expect(searchQuerySchema.parse('C:\\dir')).toBe('C:\\\\dir')
  })

  it('escapes backslashes first so the escapes it adds for quotes are not doubled', () => {
    // input: \'   ->   \\ then \'   i.e. backslash-backslash-backslash-quote
    expect(searchQuerySchema.parse("\\'")).toBe("\\\\\\'")
    expect(searchQuerySchema.parse('\\"')).toBe('\\\\\\"')
  })

  it('rejects a non-string query', () => {
    expect(searchQuerySchema.safeParse(42).success).toBe(false)
  })
})

describe('pageSizeSchema', () => {
  it.each([1, 50, 100])('accepts %d', (size) => {
    expect(pageSizeSchema.parse(size)).toBe(size)
  })

  it('rejects 0 and negatives', () => {
    expect(messagesFor(pageSizeSchema, 0)).toEqual(['Page size must be at least 1'])
    expect(messagesFor(pageSizeSchema, -5)).toEqual(['Page size must be at least 1'])
  })

  it('rejects more than 100', () => {
    expect(messagesFor(pageSizeSchema, 101)).toEqual(['Page size cannot exceed 100'])
  })

  it('rejects a fractional size', () => {
    expect(messagesFor(pageSizeSchema, 2.5)).toEqual(['Page size must be an integer'])
  })

  it('rejects a numeric string', () => {
    expect(pageSizeSchema.safeParse('10').success).toBe(false)
  })
})

describe('validateEmail / validateDateTime / validateDocumentId', () => {
  it('report success for a valid value', () => {
    expect(validateEmail('a@example.com')).toEqual({ success: true })
    expect(validateDateTime('2024-01-15T10:30:00Z')).toEqual({ success: true })
    expect(validateDocumentId('abc_123-X')).toEqual({ success: true })
  })

  it('report the first schema issue message for an invalid value', () => {
    expect(validateEmail('nope')).toEqual({ success: false, error: 'Invalid email format' })
    expect(validateDateTime('2024-13-45T10:30:00Z')).toEqual({ success: false, error: BAD_DATETIME })
    expect(validateDocumentId('has space')).toEqual({
      success: false,
      error: 'Invalid document ID format. Document IDs should only contain letters, numbers, hyphens, and underscores'
    })
  })

  it('report a type mismatch as a failure rather than throwing', () => {
    const result = validateEmail(undefined)
    expect(result.success).toBe(false)
    expect(result.error).toContain('expected string')
  })

  it('fall back to the generic message when parsing throws something that is not a Zod error', () => {
    // A hostile value: zod reads its prototype while describing the type mismatch.
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('cannot inspect')
        }
      }
    )

    expect(validateEmail(hostile)).toEqual({ success: false, error: 'Invalid email format' })
    expect(validateDateTime(hostile)).toEqual({ success: false, error: 'Invalid datetime format' })
    expect(validateDocumentId(hostile)).toEqual({ success: false, error: 'Invalid document ID' })
  })
})

describe('extractDocumentId', () => {
  it('returns a value that is already a valid id', () => {
    expect(extractDocumentId('1aB_c-D2')).toBe('1aB_c-D2')
  })

  it('extracts the id from a Docs, Sheets or Drive URL', () => {
    expect(extractDocumentId('https://docs.google.com/document/d/abc123/edit')).toBe('abc123')
    expect(extractDocumentId('https://docs.google.com/spreadsheets/d/sheet_ID-9/edit#gid=0')).toBe('sheet_ID-9')
    expect(extractDocumentId('https://drive.google.com/file/d/file-1/view?usp=sharing')).toBe('file-1')
  })

  it('throws when the value is neither an id nor a URL with /d/<id>', () => {
    expect(() => extractDocumentId('https://docs.google.com/document/edit')).toThrow('Invalid document ID or URL')
    expect(() => extractDocumentId('not an id')).toThrow('Invalid document ID or URL')
    expect(() => extractDocumentId('')).toThrow('Invalid document ID or URL')
  })
})

describe('ValidationError', () => {
  it('is an Error carrying the message, the field and the offending value', () => {
    const error = new ValidationError('bad email', 'attendees', 'nope')

    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(ValidationError)
    expect(error.name).toBe('ValidationError')
    expect(error.message).toBe('bad email')
    expect(error.field).toBe('attendees')
    expect(error.value).toBe('nope')
  })
})
