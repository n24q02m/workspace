import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthManager } from '../vendored/auth/AuthManager.js'

// vi.mock() factories are hoisted above regular const declarations, so the
// mocks referenced inside must be created via vi.hoisted().
const { formsApi, formsFactory } = vi.hoisted(() => {
  const formsApi = {
    forms: {
      create: vi.fn(),
      get: vi.fn(),
      batchUpdate: vi.fn(),
      responses: { list: vi.fn(), get: vi.fn() }
    }
  }
  return { formsApi, formsFactory: vi.fn(() => formsApi) }
})

vi.mock('googleapis', () => ({ google: { forms: formsFactory } }))

import { FormsService } from './FormsService.js'

/** Stands in for the AuthManager shim -- the service's only collaborator. */
function stubAuth() {
  const client = { credentials: {} }
  const getAuthenticatedClient = vi.fn(async () => client)
  return { auth: { getAuthenticatedClient } as unknown as AuthManager, getAuthenticatedClient, client }
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content[0]?.text ?? ''
}

describe('FormsService', () => {
  let svc: FormsService
  let auth: ReturnType<typeof stubAuth>

  beforeEach(() => {
    vi.clearAllMocks()
    auth = stubAuth()
    svc = new FormsService(auth.auth)
  })

  describe('create', () => {
    it('sends only info.title and returns the new form ID, title and responder URI', async () => {
      formsApi.forms.create.mockResolvedValue({
        data: {
          formId: 'form-1',
          info: { title: 'Survey' },
          responderUri: 'https://docs.google.com/forms/d/e/x/viewform'
        }
      })

      const result = await svc.create({ title: 'Survey' })

      expect(formsApi.forms.create).toHaveBeenCalledWith({ requestBody: { info: { title: 'Survey' } } })
      expect(JSON.parse(textOf(result))).toEqual({
        formId: 'form-1',
        title: 'Survey',
        responderUri: 'https://docs.google.com/forms/d/e/x/viewform'
      })
    })

    it('includes documentTitle only when it is given', async () => {
      formsApi.forms.create.mockResolvedValue({ data: { formId: 'form-1', info: { title: 'Survey' } } })

      await svc.create({ title: 'Survey', documentTitle: 'Q3 survey' })

      expect(formsApi.forms.create).toHaveBeenCalledWith({
        requestBody: { info: { title: 'Survey', documentTitle: 'Q3 survey' } }
      })
    })

    it('rejects a missing title instead of creating an untitled form', async () => {
      await expect(svc.create({ title: '' })).rejects.toThrow(/title is required/i)
      expect(formsApi.forms.create).not.toHaveBeenCalled()
    })
  })

  describe('get', () => {
    it('returns the form definition for a bare form ID', async () => {
      formsApi.forms.get.mockResolvedValue({ data: { formId: 'form-1', info: { title: 'Survey' } } })

      const result = await svc.get({ formId: 'form-1' })

      expect(formsApi.forms.get).toHaveBeenCalledWith({ formId: 'form-1' })
      expect(JSON.parse(textOf(result))).toEqual({ formId: 'form-1', info: { title: 'Survey' } })
    })

    it('extracts the form ID from an editor URL', async () => {
      formsApi.forms.get.mockResolvedValue({ data: { formId: 'form-1' } })

      await svc.get({ formId: 'https://docs.google.com/forms/d/form-1/edit' })

      expect(formsApi.forms.get).toHaveBeenCalledWith({ formId: 'form-1' })
    })

    it('refuses a public responder link by name rather than sending a wrong ID', async () => {
      await expect(svc.get({ formId: 'https://docs.google.com/forms/d/e/1FAIpQLSc-abc/viewform' })).rejects.toThrow(
        /responder link/i
      )
      expect(formsApi.forms.get).not.toHaveBeenCalled()
    })

    it('refuses a URL it cannot read a form ID out of', async () => {
      await expect(svc.get({ formId: 'https://forms.gle/abcd1234' })).rejects.toThrow(/Could not extract a form ID/i)
      expect(formsApi.forms.get).not.toHaveBeenCalled()
    })

    it('rejects an empty formId', async () => {
      await expect(svc.get({ formId: '  ' })).rejects.toThrow(/formId is required/i)
    })
  })

  describe('batchUpdate', () => {
    it('forwards the requests array and returns the API replies', async () => {
      const requests = [{ createItem: { item: { title: 'Q1' }, location: { index: 0 } } }]
      formsApi.forms.batchUpdate.mockResolvedValue({ data: { replies: [{ createItem: { itemId: 'i1' } }] } })

      const result = await svc.batchUpdate({ formId: 'form-1', requests })

      expect(formsApi.forms.batchUpdate).toHaveBeenCalledWith({ formId: 'form-1', requestBody: { requests } })
      expect(JSON.parse(textOf(result))).toEqual({ replies: [{ createItem: { itemId: 'i1' } }] })
    })

    it('rejects an empty requests array instead of sending a no-op batch', async () => {
      await expect(svc.batchUpdate({ formId: 'form-1', requests: [] })).rejects.toThrow(/at least one request/i)
      expect(formsApi.forms.batchUpdate).not.toHaveBeenCalled()
    })
  })

  describe('listResponses', () => {
    it('lists responses and surfaces the next page token', async () => {
      formsApi.forms.responses.list.mockResolvedValue({
        data: { responses: [{ responseId: 'r1' }], nextPageToken: 'tok' }
      })

      const result = await svc.listResponses({ formId: 'form-1' })

      expect(formsApi.forms.responses.list).toHaveBeenCalledWith({ formId: 'form-1' })
      expect(JSON.parse(textOf(result))).toEqual({ responses: [{ responseId: 'r1' }], nextPageToken: 'tok' })
    })

    it('passes paging and filter params through only when supplied', async () => {
      formsApi.forms.responses.list.mockResolvedValue({ data: {} })

      await svc.listResponses({
        formId: 'form-1',
        pageSize: 10,
        pageToken: 'tok',
        filter: 'timestamp > 2026-01-01T00:00:00Z'
      })

      expect(formsApi.forms.responses.list).toHaveBeenCalledWith({
        formId: 'form-1',
        pageSize: 10,
        pageToken: 'tok',
        filter: 'timestamp > 2026-01-01T00:00:00Z'
      })
    })

    it('reports an empty response list as an empty array, not a missing field', async () => {
      formsApi.forms.responses.list.mockResolvedValue({ data: {} })

      const result = await svc.listResponses({ formId: 'form-1' })

      expect(JSON.parse(textOf(result))).toEqual({ responses: [] })
    })
  })

  describe('getResponse', () => {
    it('returns one response by ID', async () => {
      formsApi.forms.responses.get.mockResolvedValue({ data: { responseId: 'r1', answers: {} } })

      const result = await svc.getResponse({ formId: 'form-1', responseId: 'r1' })

      expect(formsApi.forms.responses.get).toHaveBeenCalledWith({ formId: 'form-1', responseId: 'r1' })
      expect(JSON.parse(textOf(result))).toEqual({ responseId: 'r1', answers: {} })
    })

    it('rejects a missing responseId', async () => {
      await expect(svc.getResponse({ formId: 'form-1', responseId: '' })).rejects.toThrow(/responseId is required/i)
      expect(formsApi.forms.responses.get).not.toHaveBeenCalled()
    })
  })

  // Tool arguments arrive as untyped JSON: the factory forwards whatever the
  // client sent, so a required param can be absent at runtime even though the
  // method signature says it cannot. Name it instead of throwing a TypeError
  // from inside .trim().
  describe('omitted required params', () => {
    it.each([
      ['get', () => svc.get({} as never), /formId is required/i],
      ['create', () => svc.create({} as never), /title is required/i],
      ['getResponse', () => svc.getResponse({ formId: 'form-1' } as never), /responseId is required/i]
    ])('%s names the missing param', async (_action, call, expected) => {
      await expect(call()).rejects.toThrow(expected)
    })
  })

  describe('auth and error plumbing', () => {
    it('asks for a fresh authenticated client on every call (no cached client field)', async () => {
      formsApi.forms.get.mockResolvedValue({ data: {} })

      await svc.get({ formId: 'form-1' })
      await svc.get({ formId: 'form-2' })

      expect(auth.getAuthenticatedClient).toHaveBeenCalledTimes(2)
      expect(formsFactory).toHaveBeenCalledTimes(2)
      expect(formsFactory).toHaveBeenLastCalledWith(expect.objectContaining({ version: 'v1', auth: auth.client }))
    })

    it('lets an API failure reject so the tool layer can mark it isError', async () => {
      // The vendored services catch errors and return {"error": ...} text,
      // which the domain factory has to flag after the fact. Ours throws, and
      // withErrorHandling/registry turn it into isError: true.
      formsApi.forms.get.mockRejectedValue(new Error('Requested entity was not found.'))

      await expect(svc.get({ formId: 'form-1' })).rejects.toThrow('Requested entity was not found.')
    })
  })
})
