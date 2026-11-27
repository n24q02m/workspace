import type { CallToolResult } from '@modelcontextprotocol/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  getAuthenticatedClient: vi.fn(),
  driveFilesGet: vi.fn(),
  gmailAttachmentGet: vi.fn(),
  slidesGet: vi.fn(),
  slidesGetThumbnail: vi.fn(),
  gaxiosRequest: vi.fn()
}))

vi.mock('../../auth/credential-state.js', () => ({
  getAuth: () => ({
    getAuthenticatedClient: h.getAuthenticatedClient,
    listAccounts: vi.fn(async () => ({ accounts: ['seed@example.com'], primary: 'seed@example.com' }))
  }),
  getState: () => 'configured',
  resolveCredentialState: vi.fn(async () => 'configured')
}))

vi.mock('googleapis', () => ({
  google: {
    drive: () => ({ files: { get: h.driveFilesGet } }),
    gmail: () => ({ users: { messages: { attachments: { get: h.gmailAttachmentGet } } } }),
    slides: () => ({
      presentations: {
        get: h.slidesGet,
        pages: { getThumbnail: h.slidesGetThumbnail }
      }
    })
  }
}))

vi.mock('gaxios', () => ({
  request: h.gaxiosRequest
}))

import { FILES_EXTENSION_ID } from '@n24q02m/hull/extensions'
import { dispatchTool } from '../dispatch.js'
import { drive } from '../domains/drive.js'
import { gmail } from '../domains/gmail.js'
import { slides } from '../domains/slides.js'
import { MAX_INLINE_BYTES_ENV, resolveMaxInlineBytes } from './inline-download.js'
import { runWithMcpContext } from './mcp-context.js'

const parse = (res: CallToolResult) => JSON.parse((res.content[0] as { text?: string }).text ?? '{}')
const toArrayBuffer = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)

describe('inline base64 downloads (GAP-WORKSPACE-5)', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env[MAX_INLINE_BYTES_ENV]
    vi.clearAllMocks()
    h.getAuthenticatedClient.mockResolvedValue({})
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('validates WORKSPACE_MAX_INLINE_BYTES env var', () => {
    expect(resolveMaxInlineBytes()).toBe(25 * 1024 * 1024)
    process.env[MAX_INLINE_BYTES_ENV] = '1024'
    expect(resolveMaxInlineBytes()).toBe(1024)
    process.env[MAX_INLINE_BYTES_ENV] = '0'
    expect(() => resolveMaxInlineBytes()).toThrow(MAX_INLINE_BYTES_ENV)
  })

  it('returns base64 for drive.downloadFile when localPath is omitted or returnBase64 is true', async () => {
    const payload = Buffer.from('hello-pdf')
    h.driveFilesGet
      .mockResolvedValueOnce({
        data: { id: 'file-1', name: 'report.pdf', mimeType: 'application/pdf', size: String(payload.byteLength) }
      })
      .mockResolvedValueOnce({ data: toArrayBuffer(payload) })

    const res = await drive({ action: 'downloadFile', fileId: 'file-1' })
    expect(res.isError).toBeUndefined()
    expect(parse(res)).toEqual({
      fileId: 'file-1',
      name: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: payload.byteLength,
      encoding: 'base64',
      data: payload.toString('base64')
    })
  })

  it('rejects oversized Drive files, native Google Docs, missing fileId, and conflicting args', async () => {
    process.env[MAX_INLINE_BYTES_ENV] = '4'
    h.driveFilesGet.mockResolvedValueOnce({
      data: { id: 'f1', name: 'big.bin', mimeType: 'application/octet-stream', size: '10' }
    })
    const over = await drive({ action: 'downloadFile', fileId: 'f1', returnBase64: true })
    expect(over.isError).toBe(true)
    expect(parse(over).error).toContain('exceeds inline base64 limit')

    h.driveFilesGet.mockResolvedValueOnce({
      data: { id: 'f2', name: 'Doc', mimeType: 'application/vnd.google-apps.document' }
    })
    const nativeErr = await drive({ action: 'downloadFile', fileId: 'f2' })
    expect(nativeErr.isError).toBe(true)
    expect(parse(nativeErr).error).toContain('native file')

    const missing = await drive({ action: 'downloadFile' })
    expect(missing.isError).toBe(true)

    const conflict = await drive({ action: 'downloadFile', fileId: 'f1', localPath: '/tmp/a', returnBase64: true })
    expect(conflict.isError).toBe(true)
    expect(parse(conflict).error).toContain('Cannot specify both')

    const badFlag = await drive({
      action: 'downloadFile',
      fileId: 'f1',
      returnBase64: 'yes' as unknown as boolean,
      localPath: '/tmp/a'
    })
    expect(badFlag.isError).toBe(true)
  })

  it('returns inline base64 for gmail.downloadAttachment and enforces size & required fields', async () => {
    const raw = Buffer.from('attachment-bytes')
    h.gmailAttachmentGet.mockResolvedValueOnce({ data: { data: raw.toString('base64url') } })

    const res = await gmail({ action: 'downloadAttachment', messageId: 'm1', attachmentId: 'a1' })
    expect(res.isError).toBeUndefined()
    expect(parse(res)).toEqual({
      messageId: 'm1',
      attachmentId: 'a1',
      sizeBytes: raw.byteLength,
      encoding: 'base64',
      data: raw.toString('base64')
    })

    h.gmailAttachmentGet.mockResolvedValueOnce({ data: {} })
    expect((await gmail({ action: 'downloadAttachment', messageId: 'm1', attachmentId: 'a1' })).isError).toBe(true)
    expect((await gmail({ action: 'downloadAttachment', attachmentId: 'a1' })).isError).toBe(true)
    expect((await gmail({ action: 'downloadAttachment', messageId: 'm1' })).isError).toBe(true)
  })

  it('returns inline base64 for slides.getImages and slides.getSlideThumbnail with cumulative limit', async () => {
    const img1 = Buffer.from('png-one')
    const img2 = Buffer.from('png-two-larger')
    process.env[MAX_INLINE_BYTES_ENV] = '10'

    h.slidesGet.mockResolvedValueOnce({
      data: {
        slides: [
          {
            objectId: 's1',
            pageElements: [
              { objectId: 'e1', image: { contentUrl: 'https://img/1' } },
              { objectId: 'e2', image: { contentUrl: 'https://img/2' } },
              { objectId: 'e3', image: { contentUrl: 'https://img/3' } }
            ]
          }
        ]
      }
    })
    h.gaxiosRequest
      .mockResolvedValueOnce({ data: toArrayBuffer(img1), headers: { 'content-type': 'image/png' } })
      .mockResolvedValueOnce({ data: toArrayBuffer(img2), headers: { 'content-type': 'image/png' } })
      .mockRejectedValueOnce(new Error('network timeout'))

    const imgsRes = parse(await slides({ action: 'getImages', presentationId: 'deck-1' }))
    expect(imgsRes.totalBytes).toBe(img1.byteLength)
    expect(imgsRes.images[0].data).toBe(img1.toString('base64'))
    expect(imgsRes.images[1].downloadError).toContain('Cumulative inline image bytes exceed limit')
    expect(imgsRes.images[2].downloadError).toContain('network timeout')

    delete process.env[MAX_INLINE_BYTES_ENV]
    const thumbBuf = Buffer.from('thumb-bytes')
    h.slidesGetThumbnail.mockResolvedValueOnce({
      data: { contentUrl: 'https://thumb/1', width: 800, height: 600 }
    })
    h.gaxiosRequest.mockResolvedValueOnce({
      data: toArrayBuffer(thumbBuf),
      headers: { 'content-type': 'image/png; charset=utf-8' }
    })

    const thumbRes = parse(await slides({ action: 'getSlideThumbnail', presentationId: 'deck-1', slideObjectId: 's1' }))
    expect(thumbRes).toMatchObject({
      contentUrl: 'https://thumb/1',
      width: 800,
      height: 600,
      mimeType: 'image/png',
      sizeBytes: thumbBuf.byteLength,
      encoding: 'base64',
      data: thumbBuf.toString('base64')
    })

    expect((await slides({ action: 'getImages' })).isError).toBe(true)
    expect((await slides({ action: 'getSlideThumbnail', presentationId: 'deck-1' })).isError).toBe(true)
  })

  it('allows download actions over HTTP dispatch while still rejecting localPath', async () => {
    const payload = Buffer.from('http-ok')
    h.gmailAttachmentGet.mockResolvedValueOnce({ data: { data: payload.toString('base64url') } })

    const httpOk = await dispatchTool(
      'gmail',
      { action: 'downloadAttachment', messageId: 'm1', attachmentId: 'a1' },
      { allowLocalFilesystem: false }
    )
    expect(httpOk.isError).toBeUndefined()
    expect(parse(httpOk).data).toBe(payload.toString('base64'))

    const blocked = await dispatchTool(
      'gmail',
      { action: 'downloadAttachment', messageId: 'm1', attachmentId: 'a1', localPath: '/tmp/a' },
      { allowLocalFilesystem: false }
    )
    expect(blocked.isError).toBe(true)
    expect((blocked.content[0] as { text?: string }).text).toContain(
      'Parameter not available in this transport: localPath'
    )
  })

  it('attaches io.modelcontextprotocol/files payloads when client declares files capability', async () => {
    const fileBytes = Buffer.from('drive-file-content')
    h.driveFilesGet
      .mockResolvedValueOnce({ data: { id: 'f1', name: 'report.txt', mimeType: 'text/plain' } })
      .mockResolvedValueOnce({ data: toArrayBuffer(fileBytes) })

    const driveRes = await runWithMcpContext({ clientCapabilities: { extensions: { [FILES_EXTENSION_ID]: {} } } }, () =>
      drive({ action: 'downloadFile', fileId: 'f1' })
    )
    expect(driveRes._meta?.[FILES_EXTENSION_ID]).toMatchObject({
      extension: FILES_EXTENSION_ID,
      name: 'report.txt',
      mimeType: 'text/plain',
      uri: 'workspace://drive/f1'
    })
    expect(driveRes.structuredContent).toHaveProperty('file')

    const imgBytes = Buffer.from('slide-img')
    h.slidesGet.mockResolvedValueOnce({
      data: {
        slides: [
          {
            objectId: 's1',
            pageElements: [{ objectId: 'e1', image: { contentUrl: 'https://img/e1' } }]
          }
        ]
      }
    })
    h.gaxiosRequest.mockResolvedValueOnce({ data: toArrayBuffer(imgBytes), headers: { 'content-type': 'image/png' } })

    const slidesRes = await runWithMcpContext(
      { clientCapabilities: { extensions: { [FILES_EXTENSION_ID]: {} } } },
      () => slides({ action: 'getImages', presentationId: 'deck-1' })
    )
    expect(Array.isArray(slidesRes._meta?.[FILES_EXTENSION_ID])).toBe(true)
    expect(slidesRes._meta?.[FILES_EXTENSION_ID]).toHaveLength(1)
    expect(slidesRes.structuredContent).toHaveProperty('files')
  })
})
