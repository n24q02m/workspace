import { describe, it, expect, vi } from 'vitest'

// Mock the auth shim so no real credentials are needed.
vi.mock('../../auth/credential-state.js', () => ({
  getAuth: () => ({ getAuthenticatedClient: async () => ({}) })
}))
// Mock googleapis to intercept the Docs API call DocsService.getText makes.
const documentsGet = vi.fn().mockResolvedValue({ data: { title: 'Untitled', body: { content: [] }, tabs: [] } })
vi.mock('googleapis', () => ({
  google: { docs: () => ({ documents: { get: documentsGet } }) }
  // keep the Auth type import happy (type-only, erased at runtime)
}))

import { DocsService, boundDocsText, DEFAULT_DOCS_TEXT_LIMIT, PREVIEW_DOCS_TEXT_LIMIT } from './DocsService.js'
import { AuthManager } from '../auth/AuthManager.js'

describe('vendored DocsService over the shim', () => {
  it('getText routes through the shim to docs.documents.get', async () => {
    const svc = new DocsService(new AuthManager(['scope']))
    const res = await svc.getText({ documentId: 'doc1' })
    expect(documentsGet).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'doc1', includeTabsContent: true })
    )
    expect(res.content[0].type).toBe('text')
  })
  it('bounds text explicitly and preserves truncation metadata', () => {
    const bounded = boundDocsText('abcdef', 3)
    expect(bounded).toEqual({
      text: 'abc\n\n[Content truncated: showing 3 of 6 characters (3 omitted). Request a larger limit, up to 100000.]',
      truncated: true,
      totalCharacters: 6
    })
    expect(boundDocsText('abc', DEFAULT_DOCS_TEXT_LIMIT)).toEqual({
      text: 'abc',
      truncated: false,
      totalCharacters: 3
    })
  })

  it('applies the preview default to getText without changing document access', async () => {
    documentsGet.mockResolvedValueOnce({
      data: {
        title: 'Untitled',
        tabs: [
          {
            tabProperties: { tabId: 'tab-1' },
            documentTab: {
              body: {
                content: [
                  {
                    paragraph: {
                      elements: [{ textRun: { content: 'x'.repeat(PREVIEW_DOCS_TEXT_LIMIT + 10) } }]
                    }
                  }
                ]
              }
            }
          }
        ]
      }
    })

    const svc = new DocsService(new AuthManager(['scope']))
    const result = await svc.getText({ documentId: 'doc1', preview: true })
    const text = result.content[0].text
    const titlePrefix = 'Document Title: Untitled\n\n'

    expect(text).toContain('x'.repeat(PREVIEW_DOCS_TEXT_LIMIT - titlePrefix.length))
    expect(text).toContain('[Content truncated:')
    expect(text.length).toBeLessThan(PREVIEW_DOCS_TEXT_LIMIT + 120)
    expect(documentsGet).toHaveBeenLastCalledWith(
      expect.objectContaining({ documentId: 'doc1', includeTabsContent: true })
    )
  })

  it('rejects an out-of-range Docs text limit without calling Google', async () => {
    documentsGet.mockClear()
    const svc = new DocsService(new AuthManager(['scope']))
    const result = await svc.getText({ documentId: 'doc1', limit: 100_001 })

    expect(result.content[0].text).toContain('limit must be an integer from 1 to 100000')
    expect(documentsGet).not.toHaveBeenCalled()
  })

  it('imports and constructs without crashing (no gemini-extension.json marker needed)', async () => {
    const mod = await import('./DocsService.js')
    expect(mod.DocsService).toBeTypeOf('function')
  })
})
