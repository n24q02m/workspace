/**
 * Google Forms service. Ours, not vendored: gemini-cli-extensions/workspace has
 * no Forms coverage, so this file lives outside src/vendored/ where the upstream
 * sync would otherwise report it as drift (see NOTICE). It follows the vendored
 * services' shape -- constructed with an AuthManager, a private client getter,
 * public arrow-fn properties returning the MCP CallTool result -- so the domain
 * factory dispatches into it exactly like the other ten domains.
 *
 * One deliberate difference: API failures are thrown, not caught and returned as
 * {"error": ...} text the way the vendored services do. The tool layer
 * (withErrorHandling -> registry) renders a thrown error as an isError result
 * with sanitized details; the domain factory only flags a vendored {error}
 * payload after the fact (see flagErrorPayload in tools/domains/factory.ts).
 *
 * Scope note: everything here is covered by the two Forms scopes already in
 * WORKSPACE_SCOPES -- forms.body for create/get/batchUpdate, and
 * forms.responses.readonly for the two response reads.
 */

import { type forms_v1, google } from 'googleapis'
import type { AuthManager } from '../vendored/auth/AuthManager.js'
import { gaxiosOptions } from '../vendored/utils/GaxiosConfig.js'
import { logToFile } from '../vendored/utils/logger.js'

/** `.../forms/d/e/<responderId>/viewform` -- the public link, checked first. */
const RESPONDER_URL = /\/forms\/d\/e\/[\w-]+/
/** `.../forms/d/<formId>/edit` -- the editor URL, whose ID the API accepts. */
const EDITOR_URL = /\/forms\/d\/([\w-]+)/

/**
 * Forms IDs reach us either bare or pasted inside a URL, and Forms has two URL
 * shapes of which only one carries a usable ID. The editor URL
 * (`/forms/d/<formId>/edit`) holds the API's form ID; the public responder link
 * (`/forms/d/e/<responderId>/viewform`) holds a different identifier the API
 * does not accept. The shared `/d/([\w-]+)/` rule the other domains use would
 * quietly return the literal `"e"` for a responder link, so that shape is
 * refused by name instead of failing later as an opaque 404.
 */
function extractFormId(input: string): string {
  const value = input?.trim() ?? ''
  if (!value) {
    throw new Error('formId is required.')
  }
  if (!value.includes('/')) {
    return value
  }
  if (RESPONDER_URL.test(value)) {
    throw new Error(
      `"${value}" is a form's public responder link, which carries a different ID than the API uses. Open the form for editing and pass the ID from https://docs.google.com/forms/d/<formId>/edit instead.`
    )
  }
  const editor = value.match(EDITOR_URL)
  if (editor) {
    return editor[1]
  }
  throw new Error(
    `Could not extract a form ID from "${value}". Pass the ID itself, or the editor URL https://docs.google.com/forms/d/<formId>/edit.`
  )
}

function asText(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] }
}

export class FormsService {
  constructor(private authManager: AuthManager) {}

  /**
   * A new client per call, on purpose. Caching one in a field would pin the
   * OAuth2Client of whichever account called first and hand it to every later
   * caller -- the credential-isolation bug multi-account exists to prevent.
   */
  private async getFormsClient(): Promise<forms_v1.Forms> {
    const auth = await this.authManager.getAuthenticatedClient()
    return google.forms({ version: 'v1', ...gaxiosOptions, auth })
  }

  /**
   * Create an empty form. The API copies only `info.title` and
   * `info.documentTitle`; questions, description and settings are rejected here
   * and must follow in a `batchUpdate`.
   */
  public create = async ({ title, documentTitle }: { title: string; documentTitle?: string }) => {
    logToFile(`[FormsService] create title=${title}`)
    if (!title?.trim()) {
      throw new Error('title is required to create a form.')
    }
    const forms = await this.getFormsClient()
    const res = await forms.forms.create({
      requestBody: { info: { title, ...(documentTitle ? { documentTitle } : {}) } }
    })
    return asText({
      formId: res.data.formId,
      title: res.data.info?.title,
      responderUri: res.data.responderUri
    })
  }

  /** Read a form's definition: metadata, items, and the responder URI. */
  public get = async ({ formId }: { formId: string }) => {
    const id = extractFormId(formId)
    logToFile(`[FormsService] get formId=${id}`)
    const forms = await this.getFormsClient()
    const res = await forms.forms.get({ formId: id })
    return asText(res.data)
  }

  /**
   * Apply a batch of update requests -- this is the only way to add or change
   * questions, the description, or form settings after creation.
   */
  public batchUpdate = async ({ formId, requests }: { formId: string; requests: forms_v1.Schema$Request[] }) => {
    const id = extractFormId(formId)
    if (!Array.isArray(requests) || requests.length === 0) {
      throw new Error('batchUpdate needs at least one request in `requests`.')
    }
    logToFile(`[FormsService] batchUpdate formId=${id}, ${requests.length} request(s)`)
    const forms = await this.getFormsClient()
    const res = await forms.forms.batchUpdate({ formId: id, requestBody: { requests } })
    return asText(res.data)
  }

  /** List submitted responses. Read-only: the API has no way to write one. */
  public listResponses = async ({
    formId,
    pageSize,
    pageToken,
    filter
  }: {
    formId: string
    pageSize?: number
    pageToken?: string
    filter?: string
  }) => {
    const id = extractFormId(formId)
    logToFile(`[FormsService] listResponses formId=${id}`)
    const forms = await this.getFormsClient()
    const res = await forms.forms.responses.list({
      formId: id,
      ...(pageSize === undefined ? {} : { pageSize }),
      ...(pageToken === undefined ? {} : { pageToken }),
      ...(filter === undefined ? {} : { filter })
    })
    // `responses` is absent, not empty, when a form has none -- report the
    // distinction the caller cares about (no responses) rather than a hole.
    return asText({
      responses: res.data.responses ?? [],
      ...(res.data.nextPageToken ? { nextPageToken: res.data.nextPageToken } : {})
    })
  }

  /** Read one submitted response by ID. */
  public getResponse = async ({ formId, responseId }: { formId: string; responseId: string }) => {
    const id = extractFormId(formId)
    if (!responseId?.trim()) {
      throw new Error('responseId is required.')
    }
    logToFile(`[FormsService] getResponse formId=${id}, responseId=${responseId}`)
    const forms = await this.getFormsClient()
    const res = await forms.forms.responses.get({ formId: id, responseId })
    return asText(res.data)
  }
}
