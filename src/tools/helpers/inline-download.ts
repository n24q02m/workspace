import type { CallToolResult } from '@modelcontextprotocol/server'
import { buildFilePayload, FILES_EXTENSION_ID, type FilePayload } from '@n24q02m/hull/extensions'
import { request } from 'gaxios'
import { google } from 'googleapis'
import { currentAccount, runWithAccount } from '../../auth/account-context.js'
import { getAuth } from '../../auth/credential-state.js'
import { gaxiosOptions } from '../../vendored/utils/GaxiosConfig.js'
import { extractDocId } from '../../vendored/utils/IdUtils.js'
import { logToFile } from '../../vendored/utils/logger.js'
import { extractDocumentId } from '../../vendored/utils/validation.js'
import { clientSupportsFilesExtension } from './mcp-context.js'

/** Default inline binary size cap (25 MB) when returning base64 over HTTP/stdio without localPath. */
export const DEFAULT_MAX_INLINE_BYTES = 25 * 1024 * 1024
export const MAX_INLINE_BYTES_ENV = 'WORKSPACE_MAX_INLINE_BYTES'

const GOOGLE_APPS_MIME_PREFIX = 'application/vnd.google-apps.'

export function resolveMaxInlineBytes(): number {
  const raw = process.env[MAX_INLINE_BYTES_ENV]
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_INLINE_BYTES
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${MAX_INLINE_BYTES_ENV} must be a positive integer byte limit.`)
  }
  return parsed
}

export function resolveAccountArg(account: unknown): string | undefined {
  return typeof account === 'string' && account.trim() !== '' ? account.trim() : undefined
}

export function shouldUseInlineDownload(input: Record<string, unknown>): boolean {
  return (
    input.localPath === undefined ||
    input.returnBase64 === true ||
    (input.returnBase64 !== undefined && typeof input.returnBase64 !== 'boolean')
  )
}

export function validateInlineArgs(input: Record<string, unknown>): string | undefined {
  if (input.returnBase64 !== undefined && typeof input.returnBase64 !== 'boolean') {
    return 'returnBase64 must be a boolean.'
  }
  if (input.returnBase64 === true && input.localPath !== undefined) {
    return 'Cannot specify both localPath and returnBase64.'
  }
  return undefined
}

function jsonTextResult(payload: unknown, isError = false): CallToolResult {
  const result: CallToolResult = {
    content: [{ type: 'text', text: JSON.stringify(payload) }]
  }
  if (isError) result.isError = true
  return result
}

function jsonFileTransferResult(
  payload: Record<string, unknown>,
  filesPayload: FilePayload | FilePayload[] | undefined
): CallToolResult {
  if (filesPayload === undefined || !clientSupportsFilesExtension()) {
    return jsonTextResult(payload)
  }
  const extendedPayload = Array.isArray(filesPayload)
    ? { ...payload, files: filesPayload }
    : { ...payload, file: filesPayload }
  return {
    content: [{ type: 'text', text: JSON.stringify(extendedPayload) }],
    structuredContent: extendedPayload,
    _meta: {
      [FILES_EXTENSION_ID]: filesPayload
    }
  }
}

function errorTextResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error)
  return jsonTextResult({ error: message }, true)
}

function assertSizeLimit(byteLength: number, maxInlineBytes: number, label: string): void {
  if (byteLength > maxInlineBytes) {
    throw new Error(
      `${label} exceeds inline base64 limit (${byteLength} bytes > ${maxInlineBytes} bytes). Raise ${MAX_INLINE_BYTES_ENV} or pass localPath over stdio.`
    )
  }
}

async function fetchUrlBytes(url: string): Promise<{ buffer: Buffer; mimeType?: string }> {
  const response = await request<ArrayBuffer>({
    ...gaxiosOptions,
    url,
    responseType: 'arraybuffer'
  })
  const headers = response.headers as { get?: (name: string) => string | null } | Record<string, unknown> | undefined
  const rawType =
    headers && typeof headers.get === 'function'
      ? headers.get('content-type')
      : (headers as Record<string, unknown> | undefined)?.['content-type']
  const mimeType = typeof rawType === 'string' ? rawType.split(';')[0]?.trim() : undefined
  return { buffer: Buffer.from(response.data), mimeType }
}

export async function runWithOptionalAccount(
  account: unknown,
  fn: () => Promise<CallToolResult>
): Promise<CallToolResult> {
  try {
    return await runWithAccount(resolveAccountArg(account), fn)
  } catch (error) {
    return errorTextResult(error)
  }
}

export async function downloadDriveFileInline(input: Record<string, unknown>): Promise<CallToolResult> {
  const argErr = validateInlineArgs(input)
  if (argErr) return errorTextResult(argErr)
  const fileId = input.fileId
  if (typeof fileId !== 'string' || fileId.trim() === '') {
    return errorTextResult('fileId is required for downloadFile.')
  }

  try {
    const maxInlineBytes = resolveMaxInlineBytes()
    const id = extractDocumentId(fileId) || fileId
    const auth = await getAuth().getAuthenticatedClient(currentAccount())
    const drive = google.drive({ version: 'v3', auth })

    const meta = await drive.files.get({
      fileId: id,
      fields: 'id, name, mimeType, size',
      supportsAllDrives: true
    })
    const mimeType = meta.data.mimeType ?? undefined
    if (mimeType?.startsWith(GOOGLE_APPS_MIME_PREFIX)) {
      throw new Error(
        `Google Workspace native file (${mimeType}) cannot be downloaded directly as raw binary. Use domain export/read tools instead.`
      )
    }
    const declaredSize = meta.data.size !== undefined && meta.data.size !== null ? Number(meta.data.size) : undefined
    if (declaredSize !== undefined && Number.isFinite(declaredSize)) {
      assertSizeLimit(declaredSize, maxInlineBytes, `Drive file ${id}`)
    }

    const media = await drive.files.get(
      { fileId: id, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    )
    const buffer = Buffer.from(media.data as ArrayBuffer)
    assertSizeLimit(buffer.byteLength, maxInlineBytes, `Drive file ${id}`)

    const idValue = meta.data.id ?? id
    const payload = {
      fileId: idValue,
      name: meta.data.name,
      mimeType,
      sizeBytes: buffer.byteLength,
      encoding: 'base64',
      data: buffer.toString('base64')
    }
    const filePayload = buildFilePayload(buffer, meta.data.name ?? `${idValue}.bin`, {
      mimeType,
      uri: `workspace://drive/${idValue}`
    })
    return jsonFileTransferResult(payload, filePayload)
  } catch (error) {
    return errorTextResult(error)
  }
}

export async function downloadGmailAttachmentInline(input: Record<string, unknown>): Promise<CallToolResult> {
  const argErr = validateInlineArgs(input)
  if (argErr) return errorTextResult(argErr)
  const messageId = input.messageId
  const attachmentId = input.attachmentId
  if (typeof messageId !== 'string' || messageId.trim() === '') {
    return errorTextResult('messageId is required for downloadAttachment.')
  }
  if (typeof attachmentId !== 'string' || attachmentId.trim() === '') {
    return errorTextResult('attachmentId is required for downloadAttachment.')
  }

  try {
    const maxInlineBytes = resolveMaxInlineBytes()
    const auth = await getAuth().getAuthenticatedClient(currentAccount())
    const gmail = google.gmail({ version: 'v1', auth })
    const response = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: attachmentId
    })
    const rawData = response.data.data
    if (!rawData) {
      throw new Error('Attachment data is empty')
    }
    const buffer = Buffer.from(rawData, 'base64url')
    assertSizeLimit(buffer.byteLength, maxInlineBytes, `Attachment ${attachmentId}`)

    const payload = {
      messageId,
      attachmentId,
      sizeBytes: buffer.byteLength,
      encoding: 'base64',
      data: buffer.toString('base64')
    }
    const filePayload = buildFilePayload(buffer, `${attachmentId}.bin`, {
      mimeType: 'application/octet-stream',
      uri: `workspace://gmail/${messageId}/attachments/${attachmentId}`
    })
    return jsonFileTransferResult(payload, filePayload)
  } catch (error) {
    return errorTextResult(error)
  }
}

export async function downloadSlidesImagesInline(input: Record<string, unknown>): Promise<CallToolResult> {
  const argErr = validateInlineArgs(input)
  if (argErr) return errorTextResult(argErr)
  const presentationId = input.presentationId
  if (typeof presentationId !== 'string' || presentationId.trim() === '') {
    return errorTextResult('presentationId is required for getImages.')
  }

  try {
    const maxInlineBytes = resolveMaxInlineBytes()
    const id = extractDocId(presentationId) || presentationId
    const auth = await getAuth().getAuthenticatedClient(currentAccount())
    const slides = google.slides({ version: 'v1', auth })
    const presentation = await slides.presentations.get({
      presentationId: id,
      fields: 'slides(objectId,pageElements(objectId,title,description,image(contentUrl,sourceUrl)))'
    })

    const rawElements = (presentation.data.slides ?? []).flatMap((slide, index) =>
      (slide.pageElements ?? [])
        .filter((element) => element.image)
        .map((element) => ({ slideIndex: index + 1, slideObjectId: slide.objectId, element }))
    )

    let totalBytes = 0
    const images: Array<Record<string, unknown>> = []
    for (const { slideIndex, slideObjectId, element } of rawElements) {
      const entry: Record<string, unknown> = {
        slideIndex,
        slideObjectId,
        elementObjectId: element.objectId,
        title: element.title,
        description: element.description,
        contentUrl: element.image?.contentUrl,
        sourceUrl: element.image?.sourceUrl
      }
      const contentUrl = element.image?.contentUrl
      if (contentUrl) {
        try {
          const { buffer, mimeType } = await fetchUrlBytes(contentUrl)
          if (totalBytes + buffer.byteLength > maxInlineBytes) {
            entry.downloadError = `Cumulative inline image bytes exceed limit (${maxInlineBytes} bytes).`
          } else {
            totalBytes += buffer.byteLength
            entry.mimeType = mimeType ?? 'image/png'
            entry.sizeBytes = buffer.byteLength
            entry.encoding = 'base64'
            entry.data = buffer.toString('base64')
          }
        } catch (err) {
          logToFile(`[SlidesInline] Failed to download image ${element.objectId}: ${err}`)
          entry.downloadError = String(err)
        }
      }
      images.push(entry)
    }

    const filePayloads = images
      .filter((img) => typeof img.data === 'string' && typeof img.mimeType === 'string')
      .map((img) =>
        buildFilePayload(Buffer.from(img.data as string, 'base64'), `${String(img.elementObjectId ?? 'image')}.bin`, {
          mimeType: img.mimeType as string,
          uri: `workspace://slides/${id}/elements/${String(img.elementObjectId ?? 'image')}`
        })
      )

    return jsonFileTransferResult(
      {
        presentationId: id,
        encoding: 'base64',
        totalBytes,
        images
      },
      filePayloads.length > 0 ? filePayloads : undefined
    )
  } catch (error) {
    return errorTextResult(error)
  }
}

export async function downloadSlideThumbnailInline(input: Record<string, unknown>): Promise<CallToolResult> {
  const argErr = validateInlineArgs(input)
  if (argErr) return errorTextResult(argErr)
  const presentationId = input.presentationId
  const slideObjectId = input.slideObjectId
  if (typeof presentationId !== 'string' || presentationId.trim() === '') {
    return errorTextResult('presentationId is required for getSlideThumbnail.')
  }
  if (typeof slideObjectId !== 'string' || slideObjectId.trim() === '') {
    return errorTextResult('slideObjectId is required for getSlideThumbnail.')
  }

  try {
    const maxInlineBytes = resolveMaxInlineBytes()
    const id = extractDocId(presentationId) || presentationId
    const auth = await getAuth().getAuthenticatedClient(currentAccount())
    const slides = google.slides({ version: 'v1', auth })
    const thumbnail = await slides.presentations.pages.getThumbnail({
      presentationId: id,
      pageObjectId: slideObjectId
    })

    const result: Record<string, unknown> = { ...thumbnail.data }
    let filePayload: FilePayload | undefined
    if (typeof result.contentUrl === 'string' && result.contentUrl.length > 0) {
      const { buffer, mimeType } = await fetchUrlBytes(result.contentUrl)
      assertSizeLimit(buffer.byteLength, maxInlineBytes, `Slide thumbnail ${slideObjectId}`)
      const resolvedMime = mimeType ?? 'image/png'
      result.mimeType = resolvedMime
      result.sizeBytes = buffer.byteLength
      result.encoding = 'base64'
      result.data = buffer.toString('base64')
      filePayload = buildFilePayload(buffer, `${slideObjectId}-thumbnail.png`, {
        mimeType: resolvedMime,
        uri: `workspace://slides/${id}/pages/${slideObjectId}/thumbnail`
      })
    }

    return jsonFileTransferResult(result, filePayload)
  } catch (error) {
    return errorTextResult(error)
  }
}
