import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const authClient = { marker: 'oauth-client' }
  return {
    authClient,
    getAuthenticatedClient: vi.fn(async () => authClient),
    docsFactory: vi.fn(),
    documentsCreate: vi.fn(),
    documentsBatchUpdate: vi.fn()
  }
})

// Mock the auth shim so no real credentials are needed.
vi.mock('../../auth/credential-state.js', () => ({
  getAuth: () => ({ getAuthenticatedClient: async () => mocks.getAuthenticatedClient() })
}))
// Mock googleapis to intercept the Docs API calls DocsService makes.
const documentsGet = vi.fn().mockResolvedValue({ data: { title: 'Untitled', body: { content: [] }, tabs: [] } })
vi.mock('googleapis', () => ({
  google: {
    docs: (options: unknown) => {
      mocks.docsFactory(options)
      return {
        documents: { get: documentsGet, create: mocks.documentsCreate, batchUpdate: mocks.documentsBatchUpdate }
      }
    }
  }
  // keep the Auth type import happy (type-only, erased at runtime)
}))

import { AuthManager } from '../auth/AuthManager.js'
import {
  boundDocsText,
  DEFAULT_DOCS_TEXT_LIMIT,
  DocsService,
  MAX_DOCS_TEXT_LIMIT,
  PREVIEW_DOCS_TEXT_LIMIT,
  TABS_FIELD_MASK
} from './DocsService.js'

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

type ToolResult = { content: { text: string }[]; isError?: boolean }
const textOf = (res: ToolResult) => res.content[0].text
const jsonOf = (res: ToolResult) => JSON.parse(res.content[0].text)
const newService = () => new DocsService(new AuthManager(['scope']))
const para = (...runs: string[]) => ({ paragraph: { elements: runs.map((content) => ({ textRun: { content } })) } })
const tab = (tabId: string, title: string, content?: unknown[], childTabs?: unknown[]) => ({
  tabProperties: { tabId, title },
  documentTab: content ? { body: { content } } : undefined,
  childTabs
})
const truncated = (kept: number, total: number) =>
  `[Content truncated: showing ${kept} of ${total} characters (${total - kept} omitted). Request a larger limit, up to ${MAX_DOCS_TEXT_LIMIT}.]`

describe('DocsService (behavior over a mocked Docs API)', () => {
  beforeEach(() => {
    documentsGet.mockReset()
    mocks.documentsCreate.mockReset()
    mocks.documentsBatchUpdate.mockReset()
    mocks.documentsBatchUpdate.mockResolvedValue({ data: {} })
    mocks.docsFactory.mockReset()
    mocks.getAuthenticatedClient.mockReset()
    mocks.getAuthenticatedClient.mockResolvedValue(mocks.authClient)
  })

  describe('boundDocsText', () => {
    it('returns the text untouched when its length equals the limit', () => {
      expect(boundDocsText('abc', 3)).toEqual({ text: 'abc', truncated: false, totalCharacters: 3 })
    })

    it('cuts one character over the limit and names the true size in the marker', () => {
      expect(boundDocsText('ab', 1)).toEqual({
        text: `a\n\n${truncated(1, 2)}`,
        truncated: true,
        totalCharacters: 2
      })
    })

    it('treats an empty string as not truncated', () => {
      expect(boundDocsText('', 1)).toEqual({ text: '', truncated: false, totalCharacters: 0 })
    })
  })

  describe('Docs client construction', () => {
    it('builds the Docs v1 client with the authenticated client and the shared retry/timeout options', async () => {
      documentsGet.mockResolvedValue({ data: { title: 'Doc', tabs: [] } })
      await newService().getText({ documentId: 'doc1' })

      expect(mocks.docsFactory).toHaveBeenCalledTimes(1)
      expect(mocks.docsFactory).toHaveBeenCalledWith(
        expect.objectContaining({
          version: 'v1',
          auth: mocks.authClient,
          timeout: 30000,
          retryConfig: expect.objectContaining({ retry: 3 })
        })
      )
    })

    it('returns the error JSON when authentication fails, without calling the Docs API', async () => {
      mocks.getAuthenticatedClient.mockRejectedValue(new Error('no credentials for account'))
      const res = await newService().getText({ documentId: 'doc1' })

      expect(jsonOf(res)).toEqual({ error: 'no credentials for account' })
      expect(documentsGet).not.toHaveBeenCalled()
    })
  })

  describe('getText (BOUNDS fork)', () => {
    const bodyOf = (text: string) => [tab('t1', 'Main', [para(text)])]

    it('requests the document with the tab field mask, tab content and no suggestions', async () => {
      documentsGet.mockResolvedValue({ data: { title: 'Doc', tabs: bodyOf('hello') } })
      await newService().getText({ documentId: 'doc1' })

      expect(documentsGet).toHaveBeenCalledWith({
        documentId: 'doc1',
        fields: `title,${TABS_FIELD_MASK}`,
        includeTabsContent: true,
        suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS'
      })
    })

    it('returns the title and body of a single-tab document', async () => {
      documentsGet.mockResolvedValue({ data: { title: 'Doc', tabs: bodyOf('hello') } })
      const res = await newService().getText({ documentId: 'doc1' })

      expect(textOf(res)).toBe('Document Title: Doc\n\nhello')
    })

    it('omits the title prefix when the document has no title', async () => {
      documentsGet.mockResolvedValue({ data: { tabs: bodyOf('hello') } })
      const res = await newService().getText({ documentId: 'doc1' })

      expect(textOf(res)).toBe('hello')
    })

    it('returns only the title prefix for a single tab without a body', async () => {
      documentsGet.mockResolvedValue({ data: { title: 'Doc', tabs: [tab('t1', 'Main')] } })
      const res = await newService().getText({ documentId: 'doc1' })

      expect(textOf(res)).toBe('Document Title: Doc\n\n')
    })

    it('returns an empty string when the document has no tabs', async () => {
      documentsGet.mockResolvedValue({ data: { title: 'Doc', tabs: [] } })
      expect(textOf(await newService().getText({ documentId: 'doc1' }))).toBe('')
    })

    it('returns an empty string when the response carries no tabs field', async () => {
      documentsGet.mockResolvedValue({ data: { title: 'Doc' } })
      expect(textOf(await newService().getText({ documentId: 'doc1' }))).toBe('')
    })

    it('extracts the document id from a Docs URL before calling the API', async () => {
      documentsGet.mockResolvedValue({ data: { tabs: bodyOf('x') } })
      await newService().getText({ documentId: 'https://docs.google.com/document/d/AbC_123-x/edit' })

      expect(documentsGet).toHaveBeenCalledWith(expect.objectContaining({ documentId: 'AbC_123-x' }))
    })

    it('rejects an id that is neither a valid id nor a Docs URL without calling the API', async () => {
      const res = await newService().getText({ documentId: 'not a valid id!' })

      expect(jsonOf(res)).toEqual({ error: 'Invalid document ID or URL' })
      expect(documentsGet).not.toHaveBeenCalled()
    })

    describe('default, preview and explicit limits', () => {
      it('cuts a long body at 20,000 characters and ends it with the shared marker naming the true size', async () => {
        documentsGet.mockResolvedValue({ data: { tabs: bodyOf('y'.repeat(20_030)) } })
        const res = await newService().getText({ documentId: 'doc1' })

        expect(textOf(res)).toBe(`${'y'.repeat(DEFAULT_DOCS_TEXT_LIMIT)}\n\n${truncated(20_000, 20_030)}`)
        expect(textOf(res)).toContain(
          '[Content truncated: showing 20000 of 20030 characters (30 omitted). Request a larger limit, up to 100000.]'
        )
      })

      it('returns a body of exactly 20,000 characters whole, with no marker', async () => {
        documentsGet.mockResolvedValue({ data: { tabs: bodyOf('z'.repeat(DEFAULT_DOCS_TEXT_LIMIT)) } })
        const res = await newService().getText({ documentId: 'doc1' })

        expect(textOf(res)).toBe('z'.repeat(DEFAULT_DOCS_TEXT_LIMIT))
      })

      it('uses the 2,000-character preview budget when preview is set', async () => {
        documentsGet.mockResolvedValue({ data: { tabs: bodyOf('p'.repeat(2_500)) } })
        const res = await newService().getText({ documentId: 'doc1', preview: true })

        expect(textOf(res)).toBe(`${'p'.repeat(PREVIEW_DOCS_TEXT_LIMIT)}\n\n${truncated(2_000, 2_500)}`)
      })

      it('lets an explicit limit win over preview', async () => {
        documentsGet.mockResolvedValue({ data: { tabs: bodyOf('q'.repeat(3_000)) } })
        const res = await newService().getText({ documentId: 'doc1', preview: true, limit: 5_000 })

        expect(textOf(res)).toBe('q'.repeat(3_000))
      })

      it('counts the title prefix against the limit for a single-tab document', async () => {
        documentsGet.mockResolvedValue({ data: { title: 'Doc', tabs: bodyOf('abcdefghij') } })
        const res = await newService().getText({ documentId: 'doc1', limit: 25 })

        // 'Document Title: Doc\n\n' is 21 characters, the full text 31.
        expect(textOf(res)).toBe(`Document Title: Doc\n\nabcd\n\n${truncated(25, 31)}`)
      })

      it('accepts the smallest limit, 1', async () => {
        documentsGet.mockResolvedValue({ data: { tabs: bodyOf('abc') } })
        const res = await newService().getText({ documentId: 'doc1', limit: 1 })

        expect(textOf(res)).toBe(`a\n\n${truncated(1, 3)}`)
      })

      it('accepts the largest limit, 100,000', async () => {
        documentsGet.mockResolvedValue({ data: { tabs: bodyOf('abc') } })
        const res = await newService().getText({ documentId: 'doc1', limit: MAX_DOCS_TEXT_LIMIT })

        expect(textOf(res)).toBe('abc')
        expect(documentsGet).toHaveBeenCalledTimes(1)
      })

      it.each([0, -1, 1.5, 100_001, Number.NaN])(
        'rejects limit %s before touching auth or the Docs API',
        async (limit) => {
          const res = await newService().getText({ documentId: 'doc1', limit })

          expect(jsonOf(res)).toEqual({ error: 'limit must be an integer from 1 to 100000.' })
          expect(mocks.docsFactory).not.toHaveBeenCalled()
          expect(documentsGet).not.toHaveBeenCalled()
        }
      )
    })

    describe('reading one tab by tabId', () => {
      const tabs = [tab('parent', 'Parent', [para('parent body')], [tab('child', 'Child', [para('child body')])])]

      it('returns the title and the body of a top-level tab', async () => {
        documentsGet.mockResolvedValue({ data: { title: 'Doc', tabs } })
        const res = await newService().getText({ documentId: 'doc1', tabId: 'parent' })

        expect(textOf(res)).toBe('Document Title: Doc\n\nparent body')
      })

      it('finds a nested child tab', async () => {
        documentsGet.mockResolvedValue({ data: { title: 'Doc', tabs } })
        const res = await newService().getText({ documentId: 'doc1', tabId: 'child' })

        expect(textOf(res)).toBe('Document Title: Doc\n\nchild body')
      })

      it('omits the title prefix when the document has no title', async () => {
        documentsGet.mockResolvedValue({ data: { tabs } })
        const res = await newService().getText({ documentId: 'doc1', tabId: 'child' })

        expect(textOf(res)).toBe('child body')
      })

      it('returns an error naming the tab when the tabId does not exist', async () => {
        documentsGet.mockResolvedValue({ data: { title: 'Doc', tabs } })
        const res = await newService().getText({ documentId: 'doc1', tabId: 'nope' })

        expect(jsonOf(res)).toEqual({ error: 'Tab with ID nope not found.' })
      })

      it('returns an empty string for a tab without a body', async () => {
        documentsGet.mockResolvedValue({ data: { title: 'Doc', tabs: [tab('empty', 'Empty')] } })
        const res = await newService().getText({ documentId: 'doc1', tabId: 'empty' })

        expect(textOf(res)).toBe('')
      })

      it('bounds the tab text with the shared marker, counting the title prefix', async () => {
        documentsGet.mockResolvedValue({ data: { title: 'Doc', tabs: [tab('t1', 'T', [para('abcdefghij')])] } })
        const res = await newService().getText({ documentId: 'doc1', tabId: 't1', limit: 25 })

        expect(textOf(res)).toBe(`Document Title: Doc\n\nabcd\n\n${truncated(25, 31)}`)
      })
    })

    describe('reading a multi-tab document', () => {
      it('returns JSON with every tab, parents before their children, in document order', async () => {
        documentsGet.mockResolvedValue({
          data: {
            title: 'Doc',
            tabs: [
              tab('t1', 'One', [para('one')], [tab('c1', 'Child', [para('child')], [tab('g1', 'Grand', [para('grand')])])]),
              tab('t2', 'Two', [para('two')])
            ]
          }
        })
        const res = await newService().getText({ documentId: 'doc1' })

        expect(jsonOf(res)).toEqual({
          title: 'Doc',
          tabs: [
            { tabId: 't1', title: 'One', content: 'one', truncated: false, totalCharacters: 3, index: 0 },
            { tabId: 'c1', title: 'Child', content: 'child', truncated: false, totalCharacters: 5, index: 1 },
            { tabId: 'g1', title: 'Grand', content: 'grand', truncated: false, totalCharacters: 5, index: 2 },
            { tabId: 't2', title: 'Two', content: 'two', truncated: false, totalCharacters: 3, index: 3 }
          ]
        })
      })

      it('bounds each tab on its own and reports its true size, without the title in the content', async () => {
        documentsGet.mockResolvedValue({
          data: { title: 'Doc', tabs: [tab('t1', 'One', [para('abcdef')]), tab('t2', 'Two', [para('xy')])] }
        })
        const res = await newService().getText({ documentId: 'doc1', limit: 4 })

        expect(jsonOf(res).tabs).toEqual([
          {
            tabId: 't1',
            title: 'One',
            content: `abcd\n\n${truncated(4, 6)}`,
            truncated: true,
            totalCharacters: 6,
            index: 0
          },
          { tabId: 't2', title: 'Two', content: 'xy', truncated: false, totalCharacters: 2, index: 1 }
        ])
      })

      it('reports an empty, untruncated tab when a tab has no body or no properties', async () => {
        documentsGet.mockResolvedValue({
          data: { title: 'Doc', tabs: [tab('t1', 'One', [para('one')]), { childTabs: undefined }] }
        })
        const res = await newService().getText({ documentId: 'doc1' })

        expect(jsonOf(res).tabs[1]).toEqual({ content: '', truncated: false, totalCharacters: 0, index: 1 })
      })

      it('leaves the title out of the JSON when the document has none', async () => {
        documentsGet.mockResolvedValue({ data: { tabs: [tab('t1', 'One', [para('one')]), tab('t2', 'Two')] } })
        const res = await newService().getText({ documentId: 'doc1' })

        expect(jsonOf(res)).not.toHaveProperty('title')
        expect(jsonOf(res).tabs).toHaveLength(2)
      })
    })

    describe('rendering structural elements', () => {
      const singleTabText = async (element: unknown) => {
        documentsGet.mockResolvedValue({ data: { tabs: [tab('t1', 'T', [element])] } })
        return textOf(await newService().getText({ documentId: 'doc1' }))
      }
      const inParagraph = (element: object) => ({ paragraph: { elements: [element] } })

      it.each([
        ['a text run', { textRun: { content: 'Hello ' } }, 'Hello '],
        ['a text run without content', { textRun: {} }, ''],
        ['a text run with empty content', { textRun: { content: '' } }, ''],
        ['an element of an unknown kind', { somethingElse: {} }, ''],
        [
          'a person chip with name and email',
          { person: { personProperties: { name: 'Ann', email: 'ann@x.test' } } },
          '[Ann](mailto:ann@x.test)'
        ],
        [
          'a person chip with only an email',
          { person: { personProperties: { email: 'ann@x.test' } } },
          '[ann@x.test](mailto:ann@x.test)'
        ],
        ['a person chip with only a name', { person: { personProperties: { name: 'Bob' } } }, 'Bob'],
        ['a person chip with no properties set', { person: { personProperties: {} } }, ''],
        ['a person without personProperties', { person: {} }, ''],
        [
          'a rich link with title and uri',
          { richLink: { richLinkProperties: { title: 'Spec', uri: 'https://e.test/s' } } },
          '[Spec](https://e.test/s)'
        ],
        [
          'a rich link with only a uri',
          { richLink: { richLinkProperties: { uri: 'https://e.test/u' } } },
          '[https://e.test/u](https://e.test/u)'
        ],
        ['a rich link with only a title', { richLink: { richLinkProperties: { title: 'Only title' } } }, 'Only title'],
        ['a rich link with no properties set', { richLink: { richLinkProperties: {} } }, ''],
        ['a rich link without richLinkProperties', { richLink: {} }, ''],
        [
          'a date chip with display text and timestamp',
          { dateElement: { dateElementProperties: { displayText: 'Jan 1', timestamp: '2026-01-01T00:00:00Z' } } },
          'Jan 1'
        ],
        [
          'a date chip with only a timestamp',
          { dateElement: { dateElementProperties: { timestamp: '2026-01-02T00:00:00Z' } } },
          '2026-01-02T00:00:00Z'
        ],
        ['a date chip with no properties set', { dateElement: { dateElementProperties: {} } }, ''],
        ['a date element without dateElementProperties', { dateElement: {} }, '']
      ])('renders %s', async (_label, element, expected) => {
        expect(await singleTabText(inParagraph(element))).toBe(expected)
      })

      it('concatenates every element of a paragraph in order', async () => {
        const text = await singleTabText({
          paragraph: {
            elements: [
              { textRun: { content: 'Hi ' } },
              { person: { personProperties: { name: 'Ann', email: 'ann@x.test' } } },
              { textRun: { content: ' see ' } },
              { richLink: { richLinkProperties: { title: 'Spec', uri: 'https://e.test/s' } } }
            ]
          }
        })

        expect(text).toBe('Hi [Ann](mailto:ann@x.test) see [Spec](https://e.test/s)')
      })

      it('renders a paragraph without elements as nothing', async () => {
        expect(await singleTabText({ paragraph: {} })).toBe('')
      })

      it('renders an element that is neither a paragraph nor a table as nothing', async () => {
        expect(await singleTabText({ sectionBreak: {} })).toBe('')
      })

      it('reads table cells row by row, including a nested table, and skips empty rows and cells', async () => {
        const text = await singleTabText({
          table: {
            tableRows: [
              { tableCells: [{ content: [para('a1 ')] }, { content: [para('b1 ')] }] },
              { tableCells: [{ content: [para('a2 ')] }, {}] },
              {},
              {
                tableCells: [
                  { content: [{ table: { tableRows: [{ tableCells: [{ content: [para('inner ')] }] }] } }] }
                ]
              }
            ]
          }
        })

        expect(text).toBe('a1 b1 a2 inner ')
      })

      it('renders a table without rows as nothing', async () => {
        expect(await singleTabText({ table: {} })).toBe('')
      })
    })

    it('returns the error JSON when the Docs API rejects with an Error', async () => {
      documentsGet.mockRejectedValue(new Error('Request failed with status code 404'))
      const res = await newService().getText({ documentId: 'doc1' })

      expect(jsonOf(res)).toEqual({ error: 'Request failed with status code 404' })
    })

    it('stringifies a non-Error rejection into the error JSON', async () => {
      documentsGet.mockRejectedValue('quota exceeded')
      const res = await newService().getText({ documentId: 'doc1' })

      expect(jsonOf(res)).toEqual({ error: 'quota exceeded' })
    })
  })

  describe('getSuggestions', () => {
    const suggestionDoc = {
      title: 'Plan',
      body: {
        content: [
          {
            startIndex: 1,
            endIndex: 20,
            paragraph: {
              suggestedParagraphStyleChanges: { 'sg.para': { paragraphStyle: { namedStyleType: 'HEADING_1' } } },
              elements: [
                { startIndex: 1, endIndex: 6, textRun: { content: 'added', suggestedInsertionIds: ['sg.ins'] } },
                { startIndex: 6, endIndex: 11, textRun: { content: 'gone ', suggestedDeletionIds: ['sg.del'] } },
                {
                  startIndex: 11,
                  endIndex: 15,
                  textRun: {
                    content: 'bold',
                    textStyle: { bold: true },
                    suggestedTextStyleChanges: { 'sg.s1': {}, 'sg.s2': {} }
                  }
                },
                { startIndex: 15, endIndex: 20, textRun: { content: 'plain' } },
                { startIndex: 20, endIndex: 21, pageBreak: {} }
              ]
            }
          },
          { sectionBreak: {} }
        ]
      }
    }

    it('requests the document with inline suggestions and only the title and body fields', async () => {
      documentsGet.mockResolvedValue({ data: suggestionDoc })
      await newService().getSuggestions({ documentId: 'doc1' })

      expect(documentsGet).toHaveBeenCalledWith({
        documentId: 'doc1',
        suggestionsViewMode: 'SUGGESTIONS_INLINE',
        fields: 'title,body'
      })
    })

    it('extracts paragraph, insertion, deletion and style suggestions with their ranges', async () => {
      documentsGet.mockResolvedValue({ data: suggestionDoc })
      const res = await newService().getSuggestions({ documentId: 'doc1' })

      expect(res.isError).toBeUndefined()
      expect(jsonOf(res)).toEqual({
        title: 'Plan',
        suggestions: [
          {
            type: 'paragraphStyleChange',
            text: 'addedgone boldplain',
            suggestionIds: ['sg.para'],
            namedStyleType: 'HEADING_1',
            startIndex: 1,
            endIndex: 20
          },
          { type: 'insertion', text: 'added', suggestionIds: ['sg.ins'], startIndex: 1, endIndex: 6 },
          { type: 'deletion', text: 'gone ', suggestionIds: ['sg.del'], startIndex: 6, endIndex: 11 },
          {
            type: 'styleChange',
            text: 'bold',
            suggestionIds: ['sg.s1', 'sg.s2'],
            textStyle: { bold: true },
            startIndex: 11,
            endIndex: 15
          }
        ]
      })
    })

    it('extracts the document id from a Docs URL', async () => {
      documentsGet.mockResolvedValue({ data: suggestionDoc })
      await newService().getSuggestions({ documentId: 'https://docs.google.com/document/d/Doc-9_x/edit' })

      expect(documentsGet).toHaveBeenCalledWith(expect.objectContaining({ documentId: 'Doc-9_x' }))
    })

    it('finds suggestions inside table cells and skips rows and cells that are empty', async () => {
      documentsGet.mockResolvedValue({
        data: {
          title: 'Table',
          body: {
            content: [
              {
                table: {
                  tableRows: [
                    {
                      tableCells: [
                        {
                          content: [
                            {
                              paragraph: {
                                elements: [{ textRun: { content: 'cell', suggestedInsertionIds: ['sg.cell'] } }]
                              }
                            }
                          ]
                        },
                        {}
                      ]
                    },
                    {}
                  ]
                }
              },
              { table: {} }
            ]
          }
        }
      })
      const res = await newService().getSuggestions({ documentId: 'doc1' })

      expect(jsonOf(res).suggestions).toEqual([{ type: 'insertion', text: 'cell', suggestionIds: ['sg.cell'] }])
    })

    it('uses empty text and no style name when the suggestion carries neither', async () => {
      documentsGet.mockResolvedValue({
        data: {
          title: 'Sparse',
          body: {
            content: [
              {
                paragraph: {
                  suggestedParagraphStyleChanges: { 'sg.null': null },
                  elements: [{ textRun: { suggestedInsertionIds: ['sg.noText'] } }, { textRun: { content: 'x' } }]
                }
              },
              { paragraph: { suggestedParagraphStyleChanges: { 'sg.noElements': {} } } }
            ]
          }
        }
      })
      const res = await newService().getSuggestions({ documentId: 'doc1' })

      expect(jsonOf(res).suggestions).toEqual([
        { type: 'paragraphStyleChange', text: 'x', suggestionIds: ['sg.null'] },
        { type: 'insertion', text: '', suggestionIds: ['sg.noText'] },
        { type: 'paragraphStyleChange', text: '', suggestionIds: ['sg.noElements'] }
      ])
    })

    it.each([
      ['a document without a body', { title: 'Empty' }],
      ['a body without content', { title: 'Empty', body: {} }],
      ['a body with null content', { title: 'Empty', body: { content: null } }]
    ])('returns no suggestions for %s', async (_label, data) => {
      documentsGet.mockResolvedValue({ data })
      const res = await newService().getSuggestions({ documentId: 'doc1' })

      expect(jsonOf(res)).toEqual({ title: 'Empty', suggestions: [] })
    })

    it('flags the result as an error when the Docs API rejects', async () => {
      documentsGet.mockRejectedValue(new Error('The caller does not have permission'))
      const res = await newService().getSuggestions({ documentId: 'doc1' })

      expect(res.isError).toBe(true)
      expect(jsonOf(res)).toEqual({ error: 'The caller does not have permission' })
    })

    it('stringifies a non-Error rejection into the error JSON', async () => {
      documentsGet.mockRejectedValue({ code: 403 })
      const res = await newService().getSuggestions({ documentId: 'doc1' })

      expect(res.isError).toBe(true)
      expect(jsonOf(res)).toEqual({ error: '[object Object]' })
    })
  })

  describe('create', () => {
    beforeEach(() => {
      mocks.documentsCreate.mockResolvedValue({ data: { documentId: 'new1', title: 'Server Title' } })
    })

    it('creates a document with the given title and skips the content insert when no content is given', async () => {
      const res = await newService().create({ title: 'Input Title' })

      expect(mocks.documentsCreate).toHaveBeenCalledWith({ requestBody: { title: 'Input Title' } })
      expect(mocks.documentsBatchUpdate).not.toHaveBeenCalled()
      expect(jsonOf(res)).toEqual({ documentId: 'new1', title: 'Server Title' })
    })

    it('treats an empty content string as no content', async () => {
      await newService().create({ title: 'T', content: '' })

      expect(mocks.documentsBatchUpdate).not.toHaveBeenCalled()
    })

    it('inserts the content at index 1 of the new document', async () => {
      const res = await newService().create({ title: 'T', content: 'hello world' })

      expect(mocks.documentsBatchUpdate).toHaveBeenCalledWith({
        documentId: 'new1',
        requestBody: { requests: [{ insertText: { location: { index: 1 }, text: 'hello world' } }] }
      })
      expect(jsonOf(res)).toEqual({ documentId: 'new1', title: 'Server Title' })
    })

    it('returns the error JSON when the create call rejects, without inserting content', async () => {
      mocks.documentsCreate.mockRejectedValue(new Error('Insufficient Permission'))
      const res = await newService().create({ title: 'T', content: 'hello' })

      expect(jsonOf(res)).toEqual({ error: 'Insufficient Permission' })
      expect(mocks.documentsBatchUpdate).not.toHaveBeenCalled()
    })

    it('returns the error JSON when the content insert rejects', async () => {
      mocks.documentsBatchUpdate.mockRejectedValue(new Error('Invalid requests[0].insertText'))
      const res = await newService().create({ title: 'T', content: 'hello' })

      expect(jsonOf(res)).toEqual({ error: 'Invalid requests[0].insertText' })
    })

    it('stringifies a non-Error rejection into the error JSON', async () => {
      mocks.documentsCreate.mockRejectedValue('backend unavailable')
      const res = await newService().create({ title: 'T' })

      expect(jsonOf(res)).toEqual({ error: 'backend unavailable' })
    })
  })

  describe('writeText', () => {
    const sentRequests = () => mocks.documentsBatchUpdate.mock.calls[0][0].requestBody.requests

    it('appends to the main body without reading the document when position is the default end', async () => {
      const res = await newService().writeText({ documentId: 'doc1', text: 'tail' })

      expect(mocks.documentsBatchUpdate).toHaveBeenCalledWith({
        documentId: 'doc1',
        requestBody: { requests: [{ insertText: { text: 'tail' } }] }
      })
      expect(documentsGet).not.toHaveBeenCalled()
      expect(textOf(res)).toBe('Successfully wrote text to document doc1 at position end')
    })

    it('inserts at index 1 for position beginning', async () => {
      const res = await newService().writeText({ documentId: 'doc1', text: 'head', position: 'beginning' })

      expect(sentRequests()).toEqual([{ insertText: { location: { index: 1, tabId: undefined }, text: 'head' } }])
      expect(documentsGet).not.toHaveBeenCalled()
      expect(textOf(res)).toBe('Successfully wrote text to document doc1 at position beginning')
    })

    it('inserts at index 1 of the given tab for position beginning', async () => {
      await newService().writeText({ documentId: 'doc1', text: 'head', position: 'beginning', tabId: 'tabX' })

      expect(sentRequests()).toEqual([{ insertText: { location: { index: 1, tabId: 'tabX' }, text: 'head' } }])
    })

    it('inserts at a numeric position', async () => {
      await newService().writeText({ documentId: 'doc1', text: 'mid', position: '7' })

      expect(sentRequests()).toEqual([{ insertText: { location: { index: 7, tabId: undefined }, text: 'mid' } }])
    })

    it('inserts at a numeric position inside the given tab', async () => {
      await newService().writeText({ documentId: 'doc1', text: 'mid', position: '7', tabId: 'tabX' })

      expect(sentRequests()).toEqual([{ insertText: { location: { index: 7, tabId: 'tabX' }, text: 'mid' } }])
    })

    it.each(['abc', '0', '-3', ''])('rejects the position %j without writing', async (position) => {
      const res = await newService().writeText({ documentId: 'doc1', text: 'x', position })

      expect(jsonOf(res)).toEqual({
        error: `Invalid position: "${position}". Use "beginning", "end", or a positive integer index.`
      })
      expect(mocks.documentsBatchUpdate).not.toHaveBeenCalled()
    })

    it('extracts the document id from a Docs URL', async () => {
      const res = await newService().writeText({
        documentId: 'https://docs.google.com/document/d/Doc-9_x/edit',
        text: 'tail'
      })

      expect(mocks.documentsBatchUpdate).toHaveBeenCalledWith(expect.objectContaining({ documentId: 'Doc-9_x' }))
      expect(textOf(res)).toBe('Successfully wrote text to document Doc-9_x at position end')
    })

    describe('appending to a tab', () => {
      const tabs = [
        tab('t1', 'One', [para('one')]),
        tab('t2', 'Two', [{ endIndex: 5 }, { endIndex: 12 }], [tab('child', 'Child', [{ endIndex: 30 }])])
      ]

      it('reads the document with the tab field mask and inserts just before the last element of the tab', async () => {
        documentsGet.mockResolvedValue({ data: { tabs } })
        await newService().writeText({ documentId: 'doc1', text: 'tail', tabId: 't2' })

        expect(documentsGet).toHaveBeenCalledWith({
          documentId: 'doc1',
          fields: TABS_FIELD_MASK,
          includeTabsContent: true
        })
        expect(sentRequests()).toEqual([{ insertText: { location: { index: 11, tabId: 't2' }, text: 'tail' } }])
      })

      it('finds a nested child tab', async () => {
        documentsGet.mockResolvedValue({ data: { tabs } })
        await newService().writeText({ documentId: 'doc1', text: 'tail', tabId: 'child', position: 'end' })

        expect(sentRequests()).toEqual([{ insertText: { location: { index: 29, tabId: 'child' }, text: 'tail' } }])
      })

      it('falls back to index 1 when the tab has no body', async () => {
        documentsGet.mockResolvedValue({ data: { tabs: [tab('t1', 'One')] } })
        await newService().writeText({ documentId: 'doc1', text: 'tail', tabId: 't1' })

        expect(sentRequests()).toEqual([{ insertText: { location: { index: 1, tabId: 't1' }, text: 'tail' } }])
      })

      it('falls back to index 1 when the last element has no endIndex', async () => {
        documentsGet.mockResolvedValue({ data: { tabs: [tab('t1', 'One', [{}])] } })
        await newService().writeText({ documentId: 'doc1', text: 'tail', tabId: 't1' })

        expect(sentRequests()).toEqual([{ insertText: { location: { index: 1, tabId: 't1' }, text: 'tail' } }])
      })

      it('returns an error naming the tab when the document has no tabs at all', async () => {
        documentsGet.mockResolvedValue({ data: {} })
        const res = await newService().writeText({ documentId: 'doc1', text: 'tail', tabId: 't1' })

        expect(jsonOf(res)).toEqual({ error: 'Tab with ID t1 not found.' })
        expect(mocks.documentsBatchUpdate).not.toHaveBeenCalled()
      })

      it('returns an error naming the tab when the tabId does not exist, without writing', async () => {
        documentsGet.mockResolvedValue({ data: { tabs } })
        const res = await newService().writeText({ documentId: 'doc1', text: 'tail', tabId: 'nope' })

        expect(jsonOf(res)).toEqual({ error: 'Tab with ID nope not found.' })
        expect(mocks.documentsBatchUpdate).not.toHaveBeenCalled()
      })
    })

    it('returns the error JSON when the batch update rejects', async () => {
      mocks.documentsBatchUpdate.mockRejectedValue(new Error('Invalid location'))
      const res = await newService().writeText({ documentId: 'doc1', text: 'x' })

      expect(jsonOf(res)).toEqual({ error: 'Invalid location' })
    })

    it('stringifies a non-Error rejection into the error JSON', async () => {
      mocks.documentsBatchUpdate.mockRejectedValue(42)
      const res = await newService().writeText({ documentId: 'doc1', text: 'x' })

      expect(jsonOf(res)).toEqual({ error: '42' })
    })
  })

  describe('formatText', () => {
    const appliedRequests = () => mocks.documentsBatchUpdate.mock.calls[0][0].requestBody.requests

    it.each([
      ['heading1', 'HEADING_1'],
      ['heading2', 'HEADING_2'],
      ['Heading3', 'HEADING_3'],
      ['HEADING4', 'HEADING_4'],
      ['heading5', 'HEADING_5'],
      ['heading6', 'HEADING_6'],
      ['normalText', 'NORMAL_TEXT'],
      ['normaltext', 'NORMAL_TEXT']
    ])('maps the style %s to the paragraph style %s', async (style, namedStyleType) => {
      const res = await newService().formatText({ documentId: 'doc1', formats: [{ startIndex: 2, endIndex: 9, style }] })

      expect(mocks.documentsBatchUpdate).toHaveBeenCalledWith({
        documentId: 'doc1',
        requestBody: {
          requests: [
            {
              updateParagraphStyle: {
                range: { startIndex: 2, endIndex: 9, tabId: undefined },
                paragraphStyle: { namedStyleType },
                fields: 'namedStyleType'
              }
            }
          ]
        }
      })
      expect(textOf(res)).toBe('Successfully applied 1 format(s) to document doc1')
    })

    it.each([
      ['bold', 'bold'],
      ['Italic', 'italic'],
      ['UNDERLINE', 'underline'],
      ['strikethrough', 'strikethrough']
    ])('maps the style %s to a text style with only %s set', async (style, field) => {
      await newService().formatText({ documentId: 'doc1', formats: [{ startIndex: 1, endIndex: 4, style }] })

      expect(appliedRequests()).toEqual([
        {
          updateTextStyle: {
            range: { startIndex: 1, endIndex: 4, tabId: undefined },
            textStyle: { [field]: true },
            fields: field
          }
        }
      ])
    })

    it('maps code to the Courier New font', async () => {
      await newService().formatText({ documentId: 'doc1', formats: [{ startIndex: 1, endIndex: 4, style: 'CODE' }] })

      expect(appliedRequests()).toEqual([
        {
          updateTextStyle: {
            range: { startIndex: 1, endIndex: 4, tabId: undefined },
            textStyle: { weightedFontFamily: { fontFamily: 'Courier New' } },
            fields: 'weightedFontFamily'
          }
        }
      ])
    })

    it('maps link with a url to a link text style', async () => {
      await newService().formatText({
        documentId: 'doc1',
        formats: [{ startIndex: 1, endIndex: 4, style: 'Link', url: 'https://example.test/page' }]
      })

      expect(appliedRequests()).toEqual([
        {
          updateTextStyle: {
            range: { startIndex: 1, endIndex: 4, tabId: undefined },
            textStyle: { link: { url: 'https://example.test/page' } },
            fields: 'link'
          }
        }
      ])
    })

    it('puts the tabId on every range', async () => {
      await newService().formatText({
        documentId: 'doc1',
        tabId: 'tab9',
        formats: [
          { startIndex: 1, endIndex: 4, style: 'bold' },
          { startIndex: 5, endIndex: 8, style: 'heading1' }
        ]
      })

      expect(appliedRequests()[0].updateTextStyle.range).toEqual({ startIndex: 1, endIndex: 4, tabId: 'tab9' })
      expect(appliedRequests()[1].updateParagraphStyle.range).toEqual({ startIndex: 5, endIndex: 8, tabId: 'tab9' })
    })

    it('applies the valid formats in order, skips the unknown ones and counts only the applied ones', async () => {
      const res = await newService().formatText({
        documentId: 'doc1',
        formats: [
          { startIndex: 1, endIndex: 2, style: 'bold' },
          { startIndex: 3, endIndex: 4, style: 'sparkle' },
          { startIndex: 5, endIndex: 6, style: 'link' },
          { startIndex: 7, endIndex: 8, style: 'italic' }
        ]
      })

      expect(appliedRequests()).toHaveLength(2)
      expect(appliedRequests()[0].updateTextStyle.fields).toBe('bold')
      expect(appliedRequests()[1].updateTextStyle.fields).toBe('italic')
      expect(textOf(res)).toBe('Successfully applied 2 format(s) to document doc1')
    })

    it.each([
      ['an unknown style', [{ startIndex: 1, endIndex: 2, style: 'sparkle' }]],
      ['a link without a url', [{ startIndex: 1, endIndex: 2, style: 'link' }]],
      ['an empty list', []]
    ])('applies nothing and never calls Google for %s', async (_label, formats) => {
      const res = await newService().formatText({ documentId: 'doc1', formats })

      expect(textOf(res)).toBe('No valid formatting requests to apply.')
      expect(mocks.docsFactory).not.toHaveBeenCalled()
      expect(mocks.documentsBatchUpdate).not.toHaveBeenCalled()
    })

    it('extracts the document id from a Docs URL', async () => {
      const res = await newService().formatText({
        documentId: 'https://docs.google.com/document/d/Doc-9_x/edit',
        formats: [{ startIndex: 1, endIndex: 2, style: 'bold' }]
      })

      expect(mocks.documentsBatchUpdate).toHaveBeenCalledWith(expect.objectContaining({ documentId: 'Doc-9_x' }))
      expect(textOf(res)).toBe('Successfully applied 1 format(s) to document Doc-9_x')
    })

    it('returns the error JSON when the batch update rejects', async () => {
      mocks.documentsBatchUpdate.mockRejectedValue(new Error('Invalid range'))
      const res = await newService().formatText({
        documentId: 'doc1',
        formats: [{ startIndex: 1, endIndex: 2, style: 'bold' }]
      })

      expect(jsonOf(res)).toEqual({ error: 'Invalid range' })
    })

    it('stringifies a non-Error rejection into the error JSON', async () => {
      mocks.documentsBatchUpdate.mockRejectedValue('boom')
      const res = await newService().formatText({
        documentId: 'doc1',
        formats: [{ startIndex: 1, endIndex: 2, style: 'bold' }]
      })

      expect(jsonOf(res)).toEqual({ error: 'boom' })
    })

    it('returns the error JSON when a format has no style', async () => {
      const res = await newService().formatText({
        documentId: 'doc1',
        formats: [{ startIndex: 1, endIndex: 2 }] as never
      })

      expect(jsonOf(res).error).toMatch(/toLowerCase/)
      expect(mocks.documentsBatchUpdate).not.toHaveBeenCalled()
    })
  })

  describe('replaceText', () => {
    const sentRequests = () => mocks.documentsBatchUpdate.mock.calls[0][0].requestBody.requests
    const del = (tabId: string | undefined, startIndex: number, endIndex: number) => ({
      deleteContentRange: { range: { tabId, startIndex, endIndex } }
    })
    const ins = (tabId: string | undefined, index: number, text: string) => ({
      insertText: { location: { tabId, index }, text }
    })

    it('reads the tab content with the tab field mask before replacing', async () => {
      documentsGet.mockResolvedValue({ data: { tabs: [tab('t1', 'One', [para('foo')])] } })
      await newService().replaceText({ documentId: 'doc1', findText: 'foo', replaceText: 'bar' })

      expect(documentsGet).toHaveBeenCalledWith({
        documentId: 'doc1',
        fields: TABS_FIELD_MASK,
        includeTabsContent: true
      })
    })

    it('deletes then inserts at each occurrence and shifts later positions when the replacement is shorter', async () => {
      documentsGet.mockResolvedValue({ data: { tabs: [tab('t1', 'One', [para('foo bar foo')])] } })
      const res = await newService().replaceText({ documentId: 'doc1', findText: 'foo', replaceText: 'ba' })

      expect(mocks.documentsBatchUpdate).toHaveBeenCalledTimes(1)
      expect(mocks.documentsBatchUpdate.mock.calls[0][0].documentId).toBe('doc1')
      expect(sentRequests()).toEqual([del('t1', 1, 4), ins('t1', 1, 'ba'), del('t1', 8, 11), ins('t1', 8, 'ba')])
      expect(textOf(res)).toBe('Successfully replaced text in document doc1')
    })

    it('shifts later positions forward when the replacement is longer', async () => {
      documentsGet.mockResolvedValue({ data: { tabs: [tab('t1', 'One', [para('a-a')])] } })
      await newService().replaceText({ documentId: 'doc1', findText: 'a', replaceText: 'xyz' })

      expect(sentRequests()).toEqual([del('t1', 1, 2), ins('t1', 1, 'xyz'), del('t1', 5, 6), ins('t1', 5, 'xyz')])
    })

    it('does not shift positions when the replacement has the same length', async () => {
      documentsGet.mockResolvedValue({ data: { tabs: [tab('t1', 'One', [para('a-a')])] } })
      await newService().replaceText({ documentId: 'doc1', findText: 'a', replaceText: 'b' })

      expect(sentRequests()).toEqual([del('t1', 1, 2), ins('t1', 1, 'b'), del('t1', 3, 4), ins('t1', 3, 'b')])
    })

    it('does not count overlapping matches twice', async () => {
      documentsGet.mockResolvedValue({ data: { tabs: [tab('t1', 'One', [para('aaaa')])] } })
      await newService().replaceText({ documentId: 'doc1', findText: 'aa', replaceText: 'b' })

      expect(sentRequests()).toEqual([del('t1', 1, 3), ins('t1', 1, 'b'), del('t1', 2, 4), ins('t1', 2, 'b')])
    })

    it('matches text that spans several runs of a paragraph and text inside tables', async () => {
      documentsGet.mockResolvedValue({
        data: {
          tabs: [
            tab('t1', 'One', [
              para('fo', 'o '),
              { table: { tableRows: [{ tableCells: [{ content: [para('foo')] }] }] } }
            ])
          ]
        }
      })
      await newService().replaceText({ documentId: 'doc1', findText: 'foo', replaceText: 'X' })

      expect(sentRequests()).toEqual([del('t1', 1, 4), ins('t1', 1, 'X'), del('t1', 3, 6), ins('t1', 3, 'X')])
    })

    it('replaces in every tab, nested ones included, each request carrying its own tabId', async () => {
      documentsGet.mockResolvedValue({
        data: {
          tabs: [
            tab('t1', 'One', [para('foo')], [tab('c1', 'Child', [para('x foo')])]),
            tab('t2', 'Two', [para('nothing here')]),
            tab('t3', 'Three')
          ]
        }
      })
      await newService().replaceText({ documentId: 'doc1', findText: 'foo', replaceText: 'bar' })

      expect(sentRequests()).toEqual([del('t1', 1, 4), ins('t1', 1, 'bar'), del('c1', 3, 6), ins('c1', 3, 'bar')])
    })

    it('replaces only in the requested tab', async () => {
      documentsGet.mockResolvedValue({
        data: {
          tabs: [tab('t1', 'One', [para('foo')]), tab('t2', 'Two', [para('foo')], [tab('c2', 'Child', [para('foo')])])]
        }
      })
      await newService().replaceText({ documentId: 'doc1', findText: 'foo', replaceText: 'bar', tabId: 'c2' })

      expect(sentRequests()).toEqual([del('c2', 1, 4), ins('c2', 1, 'bar')])
    })

    it('returns an error naming the tab when the tabId does not exist, without writing', async () => {
      documentsGet.mockResolvedValue({ data: { tabs: [tab('t1', 'One', [para('foo')])] } })
      const res = await newService().replaceText({
        documentId: 'doc1',
        findText: 'foo',
        replaceText: 'bar',
        tabId: 'nope'
      })

      expect(jsonOf(res)).toEqual({ error: 'Tab with ID nope not found.' })
      expect(mocks.documentsBatchUpdate).not.toHaveBeenCalled()
    })

    it('sends no update and still reports success when nothing matches', async () => {
      documentsGet.mockResolvedValue({ data: { tabs: [tab('t1', 'One', [para('nothing')])] } })
      const res = await newService().replaceText({ documentId: 'doc1', findText: 'foo', replaceText: 'bar' })

      expect(mocks.documentsBatchUpdate).not.toHaveBeenCalled()
      expect(textOf(res)).toBe('Successfully replaced text in document doc1')
    })

    it('sends no update when the requested tab has no body', async () => {
      documentsGet.mockResolvedValue({ data: { tabs: [tab('t1', 'One')] } })
      await newService().replaceText({ documentId: 'doc1', findText: 'foo', replaceText: 'bar', tabId: 't1' })

      expect(mocks.documentsBatchUpdate).not.toHaveBeenCalled()
    })

    it('sends no update when the document has no tabs', async () => {
      documentsGet.mockResolvedValue({ data: {} })
      const res = await newService().replaceText({ documentId: 'doc1', findText: 'foo', replaceText: 'bar' })

      expect(mocks.documentsBatchUpdate).not.toHaveBeenCalled()
      expect(textOf(res)).toBe('Successfully replaced text in document doc1')
    })

    it('extracts the document id from a Docs URL', async () => {
      documentsGet.mockResolvedValue({ data: { tabs: [tab('t1', 'One', [para('foo')])] } })
      const res = await newService().replaceText({
        documentId: 'https://docs.google.com/document/d/Doc-9_x/edit',
        findText: 'foo',
        replaceText: 'bar'
      })

      expect(documentsGet).toHaveBeenCalledWith(expect.objectContaining({ documentId: 'Doc-9_x' }))
      expect(mocks.documentsBatchUpdate).toHaveBeenCalledWith(expect.objectContaining({ documentId: 'Doc-9_x' }))
      expect(textOf(res)).toBe('Successfully replaced text in document Doc-9_x')
    })

    it('builds the request list with a loop, so a very large number of matches does not overflow the stack', async () => {
      const matches = 150_000
      documentsGet.mockResolvedValue({ data: { tabs: [tab('t1', 'One', [para('a'.repeat(matches))])] } })
      const res = await newService().replaceText({ documentId: 'doc1', findText: 'a', replaceText: 'b' })

      expect(textOf(res)).toBe('Successfully replaced text in document doc1')
      expect(sentRequests()).toHaveLength(matches * 2)
    })

    it('returns the error JSON when reading the document rejects', async () => {
      documentsGet.mockRejectedValue(new Error('Requested entity was not found.'))
      const res = await newService().replaceText({ documentId: 'doc1', findText: 'foo', replaceText: 'bar' })

      expect(jsonOf(res)).toEqual({ error: 'Requested entity was not found.' })
      expect(mocks.documentsBatchUpdate).not.toHaveBeenCalled()
    })

    it('returns the error JSON when the batch update rejects', async () => {
      documentsGet.mockResolvedValue({ data: { tabs: [tab('t1', 'One', [para('foo')])] } })
      mocks.documentsBatchUpdate.mockRejectedValue(new Error('Invalid range'))
      const res = await newService().replaceText({ documentId: 'doc1', findText: 'foo', replaceText: 'bar' })

      expect(jsonOf(res)).toEqual({ error: 'Invalid range' })
    })

    it('stringifies a non-Error rejection into the error JSON', async () => {
      documentsGet.mockRejectedValue('offline')
      const res = await newService().replaceText({ documentId: 'doc1', findText: 'foo', replaceText: 'bar' })

      expect(jsonOf(res)).toEqual({ error: 'offline' })
    })

    it('refuses an empty findText before reading the document, since it matches at every index', async () => {
      documentsGet.mockResolvedValue({ data: { tabs: [tab('t1', 'One', [para('foo')])] } })
      const res = await newService().replaceText({ documentId: 'doc1', findText: '', replaceText: 'bar' })

      expect(jsonOf(res)).toEqual({ error: 'findText must not be empty.' })
      expect(documentsGet).not.toHaveBeenCalled()
      expect(mocks.documentsBatchUpdate).not.toHaveBeenCalled()
    })
  })
})
