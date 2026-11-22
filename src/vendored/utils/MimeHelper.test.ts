import { randomUUID } from 'node:crypto'
import { describe, it, expect, vi, afterEach } from 'vitest'

// Real randomUUID by default; individual tests queue fixed values with mockReturnValueOnce.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) }
})

import { MimeHelper } from './MimeHelper.js'

// Only the multipart path generates a boundary, so every case here sends one attachment.
const encodeWithAttachment = () =>
  MimeHelper.createMimeMessageWithAttachments({
    to: 'to@example.com',
    subject: 'hello',
    body: 'body text',
    attachments: [{ filename: 'note.txt', content: 'aGVsbG8=' }]
  })

const boundaryOf = (encoded: string): string => {
  const message = MimeHelper.decodeBase64Url(encoded)
  const match = message.match(/Content-Type: multipart\/mixed; boundary="([^"]*)"/)
  if (!match) throw new Error(`no multipart boundary in message: ${message.slice(0, 200)}`)
  return match[1]
}

describe('vendored MimeHelper multipart boundary', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.mocked(randomUUID).mockReset()
  })

  it('keeps a non-empty random suffix even when Math.random() stringifies short', () => {
    // Upstream did `Math.random().toString(36).substring(7)`. 0.5 -> "0.i", whose
    // index 7 does not exist, so the suffix was '' and the boundary collapsed to
    // `boundary_<ms>_`. Stubbing both sources reproduces exactly that draw.
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)

    expect(boundaryOf(encodeWithAttachment())).toMatch(/^boundary_1700000000000_[0-9a-f]{32}$/)
  })

  it('gives two messages built in the same millisecond different boundaries', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)

    expect(boundaryOf(encodeWithAttachment())).not.toBe(boundaryOf(encodeWithAttachment()))

    const boundaries = new Set(Array.from({ length: 50 }, () => boundaryOf(encodeWithAttachment())))
    expect(boundaries.size).toBe(50)
  })

  it('stays inside the RFC 2046 boundary charset and length limit, and delimits the parts', () => {
    const encoded = encodeWithAttachment()
    const boundary = boundaryOf(encoded)

    // bcharsnospace: DIGIT / ALPHA / "'" / "(" / ")" / "+" / "_" / "," / "-" / "." / "/" / ":" / "=" / "?"
    expect(boundary).toMatch(/^[0-9A-Za-z'()+_,\-./:=?]+$/)
    expect(boundary.length).toBeLessThan(70)

    const message = MimeHelper.decodeBase64Url(encoded)
    expect(message).toContain(`--${boundary}\r\n`)
    expect(message.endsWith(`--${boundary}--`)).toBe(true)
  })

  it('derives the suffix from randomUUID with the hyphens removed', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    vi.mocked(randomUUID).mockReturnValueOnce('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')

    expect(boundaryOf(encodeWithAttachment())).toBe('boundary_1700000000000_aaaaaaaabbbb4ccc8dddeeeeeeeeeeee')
  })

  it('draws a fresh randomUUID for every message and never consumes Math.random', () => {
    const random = vi.spyOn(Math, 'random')
    const uuid = vi.mocked(randomUUID)
    uuid.mockClear()

    encodeWithAttachment()
    encodeWithAttachment()

    expect(uuid).toHaveBeenCalledTimes(2)
    expect(random).not.toHaveBeenCalled()
  })

  it('builds the same boundary for the same millisecond and UUID, and a different one when only the UUID changes', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const uuid = vi.mocked(randomUUID)
    uuid
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222')

    const first = boundaryOf(encodeWithAttachment())
    const repeated = boundaryOf(encodeWithAttachment())
    const other = boundaryOf(encodeWithAttachment())

    expect(repeated).toBe(first)
    expect(other).not.toBe(first)
  })

  it('uses one boundary for the header, every part delimiter, and the terminator', () => {
    const encoded = MimeHelper.createMimeMessageWithAttachments({
      to: 'to@example.com',
      subject: 'two files',
      body: 'see attached',
      attachments: [
        { filename: 'a.txt', content: 'YQ==' },
        { filename: 'b.txt', content: 'Yg==' }
      ]
    })
    const boundary = boundaryOf(encoded)
    const lines = MimeHelper.decodeBase64Url(encoded).split('\r\n')

    expect(lines.filter((line) => line === `--${boundary}`)).toHaveLength(3)
    expect(lines.filter((line) => line === `--${boundary}--`)).toHaveLength(1)
    expect(lines.filter((line) => line.startsWith('--') && !line.includes(boundary))).toEqual([])
  })
})

const decode = (encoded: string): string => MimeHelper.decodeBase64Url(encoded)
const linesOf = (encoded: string): string[] => decode(encoded).split('\r\n')
const encodedSubject = (subject: string): string => `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`

describe('MimeHelper.createMimeMessage', () => {
  it('builds a minimal plain-text message with CRLF line endings', () => {
    const encoded = MimeHelper.createMimeMessage({
      to: 'to@example.com',
      subject: 'Hello',
      body: 'Line one\r\nLine two'
    })

    expect(decode(encoded)).toBe(
      [
        'To: to@example.com',
        `Subject: ${encodedSubject('Hello')}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Line one\r\nLine two'
      ].join('\r\n')
    )
  })

  it('emits every optional header in a fixed order and marks an HTML body', () => {
    const encoded = MimeHelper.createMimeMessage({
      to: 'to@example.com',
      subject: 'Report',
      body: '<p>hi</p>',
      from: 'from@example.com',
      cc: 'cc@example.com',
      bcc: 'bcc@example.com',
      replyTo: 'reply@example.com',
      inReplyTo: '<parent@mail.example.com>',
      references: '<root@mail.example.com> <parent@mail.example.com>',
      isHtml: true
    })

    expect(linesOf(encoded)).toEqual([
      'From: from@example.com',
      'To: to@example.com',
      'Cc: cc@example.com',
      'Bcc: bcc@example.com',
      'Reply-To: reply@example.com',
      'In-Reply-To: <parent@mail.example.com>',
      'References: <root@mail.example.com> <parent@mail.example.com>',
      `Subject: ${encodedSubject('Report')}`,
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>hi</p>'
    ])
  })

  it('omits optional headers that are empty or absent', () => {
    const encoded = MimeHelper.createMimeMessage({
      to: 'to@example.com',
      subject: 's',
      body: 'b',
      from: '',
      cc: '',
      bcc: '',
      replyTo: '',
      inReplyTo: '',
      references: ''
    })

    expect(linesOf(encoded).map((line) => line.split(':')[0])).toEqual(['To', 'Subject', 'Content-Type', '', 'b'])
  })

  it('encodes a non-ASCII subject as an RFC 2047 base64 UTF-8 word that round-trips', () => {
    const subject = 'Báo cáo quý 4 — 你好 🚀'
    const header = linesOf(MimeHelper.createMimeMessage({ to: 'to@example.com', subject, body: 'b' }))[1]

    const match = header.match(/^Subject: =\?utf-8\?B\?(.+)\?=$/)
    expect(match).not.toBeNull()
    expect(Buffer.from(match![1], 'base64').toString('utf-8')).toBe(subject)
  })

  it('strips CR, LF, control characters and DEL from In-Reply-To and References so no header can be injected', () => {
    const encoded = MimeHelper.createMimeMessage({
      to: 'to@example.com',
      subject: 's',
      body: 'b',
      inReplyTo: '<id@x>\r\nBcc: evil@example.com',
      references: '<a@x>\u0000\t<b@x>\u007f\n\rX-Injected: 1\u001f'
    })
    const lines = linesOf(encoded)

    expect(lines).toContain('In-Reply-To: <id@x>Bcc: evil@example.com')
    expect(lines).toContain('References: <a@x><b@x>X-Injected: 1')
    expect(lines.some((line) => line.startsWith('Bcc:') || line.startsWith('X-Injected:'))).toBe(false)
  })

  it('keeps spaces and printable characters in In-Reply-To and References', () => {
    const lines = linesOf(
      MimeHelper.createMimeMessage({
        to: 'to@example.com',
        subject: 's',
        body: 'b',
        inReplyTo: '<id+tag@x.example>',
        references: '<a@x> <b@x>'
      })
    )

    expect(lines).toContain('In-Reply-To: <id+tag@x.example>')
    expect(lines).toContain('References: <a@x> <b@x>')
  })

  it('encodes with base64url and no padding, matching the standard encoding with the URL-safe alphabet', () => {
    const outputs = Array.from({ length: 6 }, (_, index) =>
      MimeHelper.createMimeMessage({ to: 'to@example.com', subject: 's', body: `${'?'.repeat(index + 1)}>>>` })
    )

    for (const encoded of outputs) {
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(encoded).toBe(
        Buffer.from(decode(encoded)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      )
    }
    expect(outputs.some((encoded) => encoded.includes('_') || encoded.includes('-'))).toBe(true)
  })
})

describe('MimeHelper.createMimeMessageWithAttachments', () => {
  const baseline = {
    to: 'to@example.com',
    subject: 'Hello',
    body: 'Body',
    from: 'from@example.com',
    cc: 'cc@example.com',
    bcc: 'bcc@example.com',
    replyTo: 'reply@example.com',
    inReplyTo: '<parent@x>',
    references: '<root@x> <parent@x>'
  }
  const fixedMessage = (
    attachments: Array<{ filename: string; content: Buffer | string; contentType?: string }>,
    extra: { isHtml?: boolean; inReplyTo?: string; references?: string } = {}
  ): { encoded: string; boundary: string; lines: string[] } => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    vi.mocked(randomUUID).mockReturnValueOnce('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    const encoded = MimeHelper.createMimeMessageWithAttachments({ ...baseline, ...extra, attachments })
    return { encoded, boundary: boundaryOf(encoded), lines: linesOf(encoded) }
  }

  afterEach(() => {
    vi.restoreAllMocks()
    vi.mocked(randomUUID).mockReset()
  })

  it.each([
    ['undefined', undefined],
    ['an empty list', []]
  ])('falls back to the simple message when attachments is %s', (_label, attachments) => {
    for (const isHtml of [false, true]) {
      const withAttachments = MimeHelper.createMimeMessageWithAttachments({ ...baseline, attachments, isHtml })
      const simple = MimeHelper.createMimeMessage({ ...baseline, isHtml })

      expect(withAttachments).toBe(simple)
      expect(decode(withAttachments)).not.toContain('multipart/mixed')
    }
  })

  it('builds the full multipart/mixed structure with the body part first and one part per attachment', () => {
    const { boundary, lines } = fixedMessage([
      { filename: 'a.pdf', content: 'QUJD', contentType: 'application/pdf' },
      { filename: 'b.bin', content: Buffer.from('hello') }
    ])

    expect(boundary).toBe('boundary_1700000000000_aaaaaaaabbbb4ccc8dddeeeeeeeeeeee')
    expect(lines).toEqual([
      'From: from@example.com',
      'To: to@example.com',
      'Cc: cc@example.com',
      'Bcc: bcc@example.com',
      'Reply-To: reply@example.com',
      `Subject: ${encodedSubject('Hello')}`,
      'MIME-Version: 1.0',
      'In-Reply-To: <parent@x>',
      'References: <root@x> <parent@x>',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Body',
      `--${boundary}`,
      'Content-Type: application/pdf',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="a.pdf"',
      '',
      'QUJD',
      `--${boundary}`,
      'Content-Type: application/octet-stream',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="b.bin"',
      '',
      Buffer.from('hello').toString('base64'),
      `--${boundary}--`
    ])
  })

  it('marks the body part as HTML when isHtml is set', () => {
    const { boundary, lines } = fixedMessage([{ filename: 'a.txt', content: 'YQ==' }], { isHtml: true })

    expect(lines.slice(lines.indexOf(`--${boundary}`), lines.indexOf(`--${boundary}`) + 2)).toEqual([
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8'
    ])
    expect(lines).not.toContain('Content-Type: text/plain; charset=utf-8')
  })

  it('omits the optional headers that were not given', () => {
    const encoded = MimeHelper.createMimeMessageWithAttachments({
      to: 'to@example.com',
      subject: 's',
      body: 'b',
      attachments: [{ filename: 'a.txt', content: 'YQ==' }]
    })

    expect(
      linesOf(encoded)
        .slice(0, 4)
        .map((line) => line.split(':')[0])
    ).toEqual(['To', 'Subject', 'MIME-Version', 'Content-Type'])
  })

  it('strips control characters from In-Reply-To and References in the multipart headers', () => {
    const { lines } = fixedMessage([{ filename: 'a.txt', content: 'YQ==' }], {
      inReplyTo: '<id@x>\r\nBcc: evil@example.com',
      references: '<a@x>\n<b@x>\u0000'
    })

    expect(lines).toContain('In-Reply-To: <id@x>Bcc: evil@example.com')
    expect(lines).toContain('References: <a@x><b@x>')
    expect(lines.filter((line) => line.startsWith('Bcc:'))).toEqual(['Bcc: bcc@example.com'])
  })

  it('base64-encodes Buffer content and passes string content through as already encoded', () => {
    const { lines } = fixedMessage([
      { filename: 'buffer.bin', content: Buffer.from([0xfb, 0xff, 0x00, 0x10]) },
      { filename: 'string.txt', content: 'cGxhaW4=' }
    ])

    expect(lines).toContain(Buffer.from([0xfb, 0xff, 0x00, 0x10]).toString('base64'))
    expect(lines).toContain('cGxhaW4=')
  })

  it.each([
    [200, [76, 76, 48]],
    [152, [76, 76]],
    [76, [76]],
    [1, [1]]
  ])('splits %i characters of attachment content into lines of at most 76: %j', (length, expectedLengths) => {
    const content = 'A'.repeat(length)
    const { boundary, lines } = fixedMessage([{ filename: 'a.txt', content }])

    const start = lines.indexOf('Content-Disposition: attachment; filename="a.txt"') + 2
    const end = lines.indexOf(`--${boundary}--`)
    expect(lines.slice(start, end).map((line) => line.length)).toEqual(expectedLengths)
    expect(lines.slice(start, end).join('')).toBe(content)
  })

  it('writes no content lines for an empty attachment', () => {
    const { boundary, lines } = fixedMessage([{ filename: 'empty.txt', content: '' }])

    const header = lines.indexOf('Content-Disposition: attachment; filename="empty.txt"')
    expect(lines.slice(header + 1)).toEqual(['', `--${boundary}--`])
  })

  it('round-trips a large binary attachment without losing or reordering bytes', () => {
    const content = Buffer.alloc(300_000)
    for (let i = 0; i < content.length; i++) content[i] = (i * 31 + 7) % 256
    const { boundary, lines } = fixedMessage([{ filename: 'big.bin', content }])

    const start = lines.indexOf('Content-Disposition: attachment; filename="big.bin"') + 2
    const payload = lines.slice(start, lines.indexOf(`--${boundary}--`))

    expect(payload.every((line) => line.length <= 76)).toBe(true)
    expect(Buffer.from(payload.join(''), 'base64').equals(content)).toBe(true)
  })

  it('falls back to application/octet-stream when contentType is missing or empty', () => {
    const { lines } = fixedMessage([
      { filename: 'missing.bin', content: 'YQ==' },
      { filename: 'empty.bin', content: 'YQ==', contentType: '' }
    ])

    expect(lines.filter((line) => line === 'Content-Type: application/octet-stream')).toHaveLength(2)
  })

  it('strips CR and LF from the attachment content type so it cannot inject headers', () => {
    const { lines } = fixedMessage([
      { filename: 'a.txt', content: 'YQ==', contentType: 'text/plain\r\nX-Evil: 1\u0000' }
    ])

    expect(lines).toContain('Content-Type: text/plainX-Evil: 1')
    expect(lines.some((line) => line.startsWith('X-Evil:'))).toBe(false)
  })

  it('escapes quotes and backslashes in the filename and strips line breaks so the parameter cannot be broken out of', () => {
    const { lines } = fixedMessage([{ filename: 'a"b\\c.txt\r\nInjected: 1', content: 'YQ==' }])

    expect(lines).toContain(String.raw`Content-Disposition: attachment; filename="a\"b\\c.txtInjected: 1"`)
    expect(lines.some((line) => line.startsWith('Injected:'))).toBe(false)
  })

  it('keeps a plain filename untouched', () => {
    const { lines } = fixedMessage([{ filename: 'báo cáo (final) v2.pdf', content: 'YQ==' }])

    expect(lines).toContain('Content-Disposition: attachment; filename="báo cáo (final) v2.pdf"')
  })
})

describe('MimeHelper.decodeBase64Url', () => {
  it('inverts createMimeMessage for a non-ASCII body', () => {
    const body = 'Xin chào — 你好 🚀\r\nDòng hai'
    const encoded = MimeHelper.createMimeMessage({ to: 'to@example.com', subject: 's', body })

    expect(decode(encoded).endsWith(`\r\n\r\n${body}`)).toBe(true)
  })

  it('decodes the URL-safe alphabet and tolerates missing padding', () => {
    // "-__-" is base64url for the bytes 0xfb 0xff 0xfe, none of which is valid UTF-8.
    expect(MimeHelper.decodeBase64Url('-__-')).toBe('\u{FFFD}\u{FFFD}\u{FFFD}')
    expect(MimeHelper.decodeBase64Url('aGVsbG8')).toBe('hello')
    expect(MimeHelper.decodeBase64Url('aGVsbG8=')).toBe('hello')
  })

  it('decodes an empty string to an empty string', () => {
    expect(MimeHelper.decodeBase64Url('')).toBe('')
  })

  it('decodes characters that standard base64 would write as + and /', () => {
    const original = '??>>~~'
    const urlSafe = Buffer.from(original).toString('base64url')

    expect(urlSafe).toMatch(/[-_]/)
    expect(MimeHelper.decodeBase64Url(urlSafe)).toBe(original)
  })
})
