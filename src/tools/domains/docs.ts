/**
 * Docs Mega Tool
 * All Google Docs operations in one unified interface, dispatched by `action`
 * to the vendored DocsService via the generic domain factory.
 */

import type { CallToolResult } from '@modelcontextprotocol/server'
import { buildFilePayload, FILES_EXTENSION_ID } from '@n24q02m/hull/extensions'
import { DocsService } from '../../vendored/services/DocsService.js'
import { extractDocId } from '../../vendored/utils/IdUtils.js'
import { clientSupportsFilesExtension } from '../helpers/mcp-context.js'
import { DOCS_BOUNDS } from './bounds.js'
import { type DomainRunInput, makeDomainRun } from './factory.js'

// Action name = DocsService method name (verbatim).
export const DOCS_ACTIONS = ['getText', 'create', 'writeText', 'getSuggestions', 'replaceText', 'formatText'] as const

const runDocsBase = makeDomainRun(DocsService, DOCS_ACTIONS, { bounds: DOCS_BOUNDS })

export async function docs(input: DomainRunInput): Promise<CallToolResult> {
  const result = await runDocsBase(input)
  if (input.action !== 'getText' || result.isError || !clientSupportsFilesExtension()) {
    return result
  }
  const firstBlock = result.content[0]
  if (firstBlock?.type !== 'text') return result
  let isJson = false
  try {
    const parsed = JSON.parse(firstBlock.text) as Record<string, unknown>
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.error === 'string') return result
      isJson = true
    }
  } catch {
    // Single-tab DocsService.getText returns plain text; attach as text/plain.
  }
  const rawId = typeof input.documentId === 'string' ? input.documentId : 'document'
  const docId = extractDocId(rawId) || rawId
  const filePayload = buildFilePayload(firstBlock.text, `${docId}.${isJson ? 'json' : 'txt'}`, {
    mimeType: isJson ? 'application/json' : 'text/plain; charset=utf-8',
    uri: `workspace://docs-file/${docId}`
  })
  return {
    ...result,
    structuredContent: {
      documentId: docId,
      file: filePayload
    },
    _meta: {
      ...(result._meta ?? {}),
      [FILES_EXTENSION_ID]: filePayload
    }
  }
}
