import fs, * as mockedFs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, type TestContext, vi } from 'vitest'

const {
  filesGet,
  filesList,
  filesCreate,
  filesUpdate,
  commentsList,
  driveFactory,
  getAuthenticatedClient,
  authClient,
  projectRoot,
  mkdir,
  writeFile
} = vi.hoisted(() => {
  const filesGet = vi.fn()
  const filesList = vi.fn()
  const filesCreate = vi.fn()
  const filesUpdate = vi.fn()
  const commentsList = vi.fn()
  const authClient = { tag: 'oauth-client' }
  return {
    filesGet,
    filesList,
    filesCreate,
    filesUpdate,
    commentsList,
    authClient,
    driveFactory: vi.fn(() => ({
      files: { get: filesGet, list: filesList, create: filesCreate, update: filesUpdate },
      comments: { list: commentsList }
    })),
    getAuthenticatedClient: vi.fn(async () => authClient),
    // `undefined` keeps the real PROJECT_ROOT; the real-filesystem tests point it at a mkdtemp directory.
    projectRoot: { override: undefined as string | undefined },
    mkdir: vi.fn(),
    writeFile: vi.fn()
  }
})

vi.mock('../../auth/credential-state.js', () => ({
  getAuth: () => ({ getAuthenticatedClient })
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    promises: { ...actual.promises, mkdir, writeFile }
  }
})

vi.mock('../utils/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/paths.js')>()
  return {
    ...actual,
    get PROJECT_ROOT() {
      return projectRoot.override ?? actual.PROJECT_ROOT
    }
  }
})

vi.mock('googleapis', () => ({
  google: { drive: driveFactory }
}))

import { AuthManager } from '../auth/AuthManager.js'
import { PROJECT_ROOT } from '../utils/paths.js'
import { DriveService } from './DriveService.js'

const fileId = 'local-contract-file-id-12345'

type ToolResult = { content: { type: 'text'; text: string }[] }
const textOf = (result: ToolResult): string => result.content[0].text
const jsonOf = (result: ToolResult): any => JSON.parse(textOf(result))
const isErrorOf = (result: unknown): boolean | undefined => (result as { isError?: boolean }).isError
const newService = () => new DriveService(new AuthManager(['scope']))

function resetMocks() {
  for (const mock of [
    filesGet,
    filesList,
    filesCreate,
    filesUpdate,
    commentsList,
    driveFactory,
    getAuthenticatedClient,
    mkdir,
    writeFile
  ]) {
    mock.mockReset()
  }
}

describe('DriveService downloadFile local filesystem contract', () => {
  beforeEach(() => {
    filesGet.mockReset()
    filesList.mockReset()
    mkdir.mockReset()
    writeFile.mockReset()
    mkdir.mockResolvedValue(undefined)
    writeFile.mockResolvedValue(undefined)
    filesList.mockResolvedValue({ data: { files: [] } })
    filesGet
      .mockResolvedValueOnce({
        data: { name: 'report.pdf', mimeType: 'application/pdf' }
      })
      .mockResolvedValueOnce({ data: new Uint8Array([1, 2, 3]).buffer })
  })

  async function download(localPath: string) {
    const service = new DriveService(new AuthManager(['scope']))
    return service.downloadFile({ fileId, localPath })
  }

  it('resolves a normal relative destination under PROJECT_ROOT in local stdio mode', async () => {
    const localPath = 'downloads/report.pdf'
    const expectedPath = path.resolve(PROJECT_ROOT, localPath)

    const result = await download(localPath)

    expect(writeFile).toHaveBeenCalledWith(expectedPath, expect.any(Buffer))
    expect(result.content[0].text).toContain(expectedPath)
  })

  it('keeps an explicit absolute destination unchanged if inside PROJECT_ROOT', async () => {
    const localPath = path.join(PROJECT_ROOT, 'downloads', 'report.pdf')

    await download(localPath)

    expect(writeFile).toHaveBeenCalledWith(localPath, expect.any(Buffer))
  })

  it('rejects absolute paths outside PROJECT_ROOT', async () => {
    const localPath = '/etc/passwd'

    const result = await download(localPath)
    expect(result.content[0].text).toContain('localPath must be within the project root')
  })

  it('rejects local relative traversal that escapes PROJECT_ROOT', async () => {
    const localPath = '../../outside-report.pdf'

    const result = await download(localPath)
    expect(result.content[0].text).toContain('localPath must be within the project root')
  })

  it('rejects sibling directory bypass attempts', async () => {
    // e.g. if PROJECT_ROOT is /app/my-project, this attempts to write to /app/my-project-sibling
    const localPath = '../' + path.basename(PROJECT_ROOT) + '-sibling/report.pdf'

    const result = await download(localPath)
    expect(result.content[0].text).toContain('localPath must be within the project root')
  })

  it('does not decode encoded traversal segments in the local caller contract', async () => {
    const localPath = '%2e%2e/%2e%2e/encoded-report.pdf'
    const expectedPath = path.resolve(PROJECT_ROOT, localPath)

    await download(localPath)

    expect(expectedPath).toContain('%2e%2e')
    expect(writeFile).toHaveBeenCalledWith(expectedPath, expect.any(Buffer))
  })
})

describe('DriveService search URL hostname validation', () => {
  beforeEach(() => {
    filesGet.mockReset()
    filesList.mockReset()
    filesList.mockResolvedValue({ data: { files: [] } })
  })

  it.each([
    'drive.google.com.attacker.example',
    'docs.google.com.attacker.example'
  ])('does not treat a URL with a forged %s hostname as a Google Drive URL', async (hostname) => {
    const query = `https://${hostname}/file/d/attacker-file-id-12345678901234567890`
    const service = new DriveService(new AuthManager(['scope']))

    await service.search({ query })

    expect(filesGet).not.toHaveBeenCalled()
    expect(filesList).toHaveBeenCalledWith(expect.objectContaining({
      q: `fullText contains '${query}'`
    }))
  })

  it.each([
    ['drive.google.com', 'drive-file-id-12345678901234567890'],
    ['docs.google.com', 'docs-file-id-12345678901234567890']
  ])('still treats the exact %s hostname as a Google Drive URL', async (hostname, fileId) => {
    const service = new DriveService(new AuthManager(['scope']))
    filesGet.mockReset()
    filesGet.mockResolvedValue({ data: { id: fileId, name: 'report.pdf' } })

    await service.search({ query: `https://${hostname}/file/d/${fileId}` })

    expect(filesGet).toHaveBeenCalledWith({
      fileId,
      fields: 'id, name, modifiedTime, viewedByMeTime, mimeType, parents',
      supportsAllDrives: true
    })
    expect(filesList).not.toHaveBeenCalled()
  })
})

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const LIST_FIELDS = 'nextPageToken, files(id, name, modifiedTime, viewedByMeTime, mimeType, parents)'
const GET_FIELDS = 'id, name, modifiedTime, viewedByMeTime, mimeType, parents'
// Exactly MIN_DRIVE_ID_LENGTH (25) characters.
const DRIVE_ID = 'abcdefghijklmnopqrstuvwxy'
const URL_ID = 'url-file-id-1234567890abcde'

describe('DriveService client construction', () => {
  beforeEach(resetMocks)

  it('builds a v3 client from the authenticated OAuth client with the shared retry and timeout options', async () => {
    getAuthenticatedClient.mockResolvedValue(authClient)
    filesList.mockResolvedValue({ data: { files: [] } })

    await newService().findFolder({ folderName: 'Reports' })

    expect(driveFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 'v3',
        auth: authClient,
        timeout: 30000,
        retryConfig: expect.objectContaining({ retry: 3, noResponseRetries: 3 })
      })
    )
  })

  it('reports an authentication failure as an error result instead of throwing', async () => {
    getAuthenticatedClient.mockRejectedValue(new Error('token revoked'))

    const result = await newService().findFolder({ folderName: 'Reports' })

    expect(isErrorOf(result)).toBe(true)
    expect(jsonOf(result)).toEqual({ error: 'token revoked' })
    expect(filesList).not.toHaveBeenCalled()
  })
})

describe('DriveService.findFolder', () => {
  beforeEach(() => {
    resetMocks()
  })

  it('searches folders by name with quote and backslash escaping and returns the matches', async () => {
    const folders = [{ id: 'folder-1', name: "O'Brien\\docs" }]
    filesList.mockResolvedValue({ data: { files: folders } })

    const result = await newService().findFolder({ folderName: "O'Brien\\docs" })

    expect(filesList).toHaveBeenCalledWith({
      q: String.raw`mimeType='application/vnd.google-apps.folder' and name = 'O\'Brien\\docs'`,
      fields: 'files(id, name)',
      spaces: 'drive',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    })
    expect(jsonOf(result)).toEqual(folders)
    expect(isErrorOf(result)).toBeUndefined()
  })

  it('returns an empty list when the API response has no files field', async () => {
    filesList.mockResolvedValue({ data: {} })

    const result = await newService().findFolder({ folderName: 'Missing' })

    expect(jsonOf(result)).toEqual([])
  })

  it('returns the API error message as an error result', async () => {
    filesList.mockRejectedValue(new Error('quota exceeded'))

    const result = await newService().findFolder({ folderName: 'Reports' })

    expect(isErrorOf(result)).toBe(true)
    expect(jsonOf(result)).toEqual({ error: 'quota exceeded' })
  })

  it('stringifies a non-Error rejection into the error result', async () => {
    filesList.mockRejectedValue('plain failure')

    const result = await newService().findFolder({ folderName: 'Reports' })

    expect(isErrorOf(result)).toBe(true)
    expect(jsonOf(result)).toEqual({ error: 'plain failure' })
  })
})

describe('DriveService.createFolder', () => {
  beforeEach(() => {
    resetMocks()
  })

  it('creates a top-level folder without a parents field', async () => {
    filesCreate.mockResolvedValue({ data: { id: 'new-1', name: 'Reports', extra: 'ignored' } })

    const result = await newService().createFolder({ name: 'Reports' })

    expect(filesCreate).toHaveBeenCalledWith({
      requestBody: { name: 'Reports', mimeType: FOLDER_MIME },
      fields: 'id, name',
      supportsAllDrives: true
    })
    expect(filesCreate.mock.calls[0][0].requestBody).not.toHaveProperty('parents')
    expect(jsonOf(result)).toEqual({ id: 'new-1', name: 'Reports' })
  })

  it('places the folder under the given parent', async () => {
    filesCreate.mockResolvedValue({ data: { id: 'new-2', name: 'Q4' } })

    const result = await newService().createFolder({ name: 'Q4', parentId: 'parent-9' })

    expect(filesCreate).toHaveBeenCalledWith({
      requestBody: { name: 'Q4', mimeType: FOLDER_MIME, parents: ['parent-9'] },
      fields: 'id, name',
      supportsAllDrives: true
    })
    expect(jsonOf(result)).toEqual({ id: 'new-2', name: 'Q4' })
  })

  it('returns the API error message when creation fails', async () => {
    filesCreate.mockRejectedValue(new Error('insufficient permissions'))

    const result = await newService().createFolder({ name: 'Reports' })

    expect(jsonOf(result)).toEqual({ error: 'insufficient permissions' })
  })

  it('stringifies a non-Error rejection when creation fails', async () => {
    filesCreate.mockRejectedValue(503)

    const result = await newService().createFolder({ name: 'Reports' })

    expect(jsonOf(result)).toEqual({ error: '503' })
  })
})

describe('DriveService.search query building', () => {
  beforeEach(() => {
    resetMocks()
    filesList.mockResolvedValue({ data: { files: [{ id: 'f1', name: 'one' }] } })
  })

  const listedQuery = (): string | undefined => filesList.mock.calls[0][0].q

  it('lists with the default page size and no filter when called without a query', async () => {
    const result = await newService().search({})

    expect(filesList).toHaveBeenCalledWith({
      q: undefined,
      pageSize: 10,
      pageToken: undefined,
      corpus: undefined,
      fields: LIST_FIELDS,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    })
    expect(jsonOf(result)).toEqual({ files: [{ id: 'f1', name: 'one' }] })
    expect(filesGet).not.toHaveBeenCalled()
  })

  it('forwards pageSize, pageToken and corpus to the list call', async () => {
    await newService().search({ query: 'trashed = false', pageSize: 3, pageToken: 'tok-1', corpus: 'domain' })

    expect(filesList).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'trashed = false', pageSize: 3, pageToken: 'tok-1', corpus: 'domain' })
    )
  })

  it.each([
    ["title: 'My Report'", "name contains 'My Report'"],
    ['title:"My Report"', "name contains 'My Report'"],
    ['  title:   Plain Name  ', "name contains 'Plain Name'"],
    ["title: it's here", "name contains 'it\\'s here'"],
    ['title:\'mismatched"', "name contains '\\'mismatched\"'"]
  ])('turns the title query %j into a name-contains query', async (query, expected) => {
    await newService().search({ query })

    expect(listedQuery()).toBe(expected)
  })

  it('lists the contents of a folder when the query is a bare Drive ID', async () => {
    await newService().search({ query: `  ${DRIVE_ID}  ` })

    expect(listedQuery()).toBe(`'${DRIVE_ID}' in parents`)
  })

  it('treats a 24-character token as free text, not as a Drive ID', async () => {
    await newService().search({ query: DRIVE_ID.slice(0, 24) })

    expect(listedQuery()).toBe(`fullText contains '${DRIVE_ID.slice(0, 24)}'`)
  })

  it.each([
    "name contains 'budget'",
    "mimeType = 'application/pdf' and trashed = false",
    "'a' in parents or 'b' in parents",
    'starred not trashed',
    'trashed=false'
  ])('passes the Drive query %j through unchanged', async (query) => {
    await newService().search({ query })

    expect(listedQuery()).toBe(query)
  })

  it('wraps free text in a full-text query and escapes quotes and backslashes', async () => {
    await newService().search({ query: "  it's a C:\\temp plan  " })

    expect(listedQuery()).toBe(String.raw`fullText contains 'it\'s a C:\\temp plan'`)
  })

  it('appends the shared-with-me filter to an existing query', async () => {
    await newService().search({ query: 'budget', sharedWithMe: true })

    expect(listedQuery()).toBe("fullText contains 'budget' and sharedWithMe")
  })

  it('uses the shared-with-me filter alone when there is no query', async () => {
    await newService().search({ sharedWithMe: true })

    expect(listedQuery()).toBe('sharedWithMe')
  })

  it('keeps only never-viewed files when unreadOnly is set', async () => {
    filesList.mockResolvedValue({
      data: {
        files: [
          { id: 'seen', name: 'seen', viewedByMeTime: '2025-01-01T00:00:00Z' },
          { id: 'unseen', name: 'unseen' }
        ]
      }
    })

    const result = await newService().search({ unreadOnly: true, corpus: 'user' })

    expect(jsonOf(result).files).toEqual([{ id: 'unseen', name: 'unseen' }])
  })

  it('returns every file when unreadOnly is not set', async () => {
    filesList.mockResolvedValue({
      data: { files: [{ id: 'seen', viewedByMeTime: '2025-01-01T00:00:00Z' }, { id: 'unseen' }] }
    })

    const result = await newService().search({})

    expect(jsonOf(result).files.map((file: { id: string }) => file.id)).toEqual(['seen', 'unseen'])
  })

  it('returns the next page cursor so the caller can continue', async () => {
    filesList.mockResolvedValue({ data: { files: [{ id: 'f1' }], nextPageToken: 'cursor-2' } })

    const result = await newService().search({ query: 'budget' })

    expect(jsonOf(result)).toEqual({ files: [{ id: 'f1' }], nextPageToken: 'cursor-2' })
  })

  it('returns an empty file list when the API response has no files field', async () => {
    filesList.mockResolvedValue({ data: {} })

    const result = await newService().search({ query: 'budget' })

    expect(jsonOf(result)).toEqual({ files: [] })
  })

  it('returns the API error message when listing fails', async () => {
    filesList.mockRejectedValue(new Error('rate limited'))

    const result = await newService().search({ query: 'budget' })

    expect(jsonOf(result)).toEqual({ error: 'rate limited' })
  })

  it('stringifies a non-Error rejection when listing fails', async () => {
    filesList.mockRejectedValue('offline')

    const result = await newService().search({ query: 'budget' })

    expect(jsonOf(result)).toEqual({ error: 'offline' })
  })
})

describe('DriveService.search Drive URLs', () => {
  beforeEach(() => {
    resetMocks()
    filesList.mockResolvedValue({ data: { files: [] } })
  })

  it.each([
    `https://drive.google.com/drive/folders/${URL_ID}?usp=sharing`,
    `https://drive.google.com/drive/u/0/folders/${URL_ID}`
  ])('lists the contents of the folder behind %s without a files.get lookup', async (query) => {
    await newService().search({ query })

    expect(filesGet).not.toHaveBeenCalled()
    expect(filesList).toHaveBeenCalledWith(expect.objectContaining({ q: `'${URL_ID}' in parents` }))
  })

  it('combines a folder URL with the shared-with-me filter', async () => {
    await newService().search({
      query: `https://drive.google.com/drive/folders/${URL_ID}`,
      sharedWithMe: true
    })

    expect(filesList).toHaveBeenCalledWith(expect.objectContaining({ q: `'${URL_ID}' in parents and sharedWithMe` }))
  })

  it.each([
    `https://drive.google.com/file/d/${URL_ID}/view?usp=sharing`,
    `https://docs.google.com/document/d/${URL_ID}/edit`,
    `https://docs.google.com/spreadsheets/d/${URL_ID}/edit#gid=0`,
    `https://docs.google.com/presentation/d/${URL_ID}/edit`,
    `https://docs.google.com/forms/d/${URL_ID}/edit`
  ])('fetches the single file behind %s with files.get', async (query) => {
    filesGet.mockResolvedValue({ data: { id: URL_ID, name: 'Target' } })

    const result = await newService().search({ query })

    expect(filesGet).toHaveBeenCalledTimes(1)
    expect(filesGet).toHaveBeenCalledWith({ fileId: URL_ID, fields: GET_FIELDS, supportsAllDrives: true })
    expect(filesList).not.toHaveBeenCalled()
    expect(jsonOf(result)).toEqual({ files: [{ id: URL_ID, name: 'Target' }], nextPageToken: null })
  })

  it('looks up the type of an id= URL and lists the folder when it is a folder', async () => {
    filesGet.mockResolvedValue({ data: { mimeType: FOLDER_MIME } })

    await newService().search({ query: `https://drive.google.com/open?id=${URL_ID}` })

    expect(filesGet).toHaveBeenCalledTimes(1)
    expect(filesGet).toHaveBeenCalledWith({ fileId: URL_ID, fields: 'mimeType', supportsAllDrives: true })
    expect(filesList).toHaveBeenCalledWith(expect.objectContaining({ q: `'${URL_ID}' in parents` }))
  })

  it('fetches the file after an id= URL turns out not to be a folder', async () => {
    filesGet
      .mockResolvedValueOnce({ data: { mimeType: 'application/pdf' } })
      .mockResolvedValueOnce({ data: { id: URL_ID, name: 'Doc' } })

    const result = await newService().search({ query: `https://drive.google.com/open?id=${URL_ID}` })

    expect(filesGet).toHaveBeenNthCalledWith(2, { fileId: URL_ID, fields: GET_FIELDS, supportsAllDrives: true })
    expect(filesList).not.toHaveBeenCalled()
    expect(jsonOf(result)).toEqual({ files: [{ id: URL_ID, name: 'Doc' }], nextPageToken: null })
  })

  it('treats an id= URL as a file when its type lookup fails', async () => {
    filesGet
      .mockRejectedValueOnce(new Error('type lookup failed'))
      .mockResolvedValueOnce({ data: { id: URL_ID, name: 'Doc' } })

    const result = await newService().search({ query: `https://docs.google.com/open?id=${URL_ID}` })

    expect(filesGet).toHaveBeenCalledTimes(2)
    expect(jsonOf(result)).toEqual({ files: [{ id: URL_ID, name: 'Doc' }], nextPageToken: null })
  })

  it('returns the API error message when fetching the file behind a URL fails', async () => {
    filesGet.mockRejectedValue(new Error('File not found'))

    const result = await newService().search({ query: `https://drive.google.com/file/d/${URL_ID}/view` })

    expect(jsonOf(result)).toEqual({ error: 'File not found' })
    expect(filesList).not.toHaveBeenCalled()
  })

  it('stringifies a non-Error rejection when fetching the file behind a URL fails', async () => {
    filesGet.mockRejectedValue('gone')

    const result = await newService().search({ query: `https://drive.google.com/file/d/${URL_ID}/view` })

    expect(jsonOf(result)).toEqual({ error: 'gone' })
  })

  it('rejects a Drive URL that carries no file or folder ID without calling the API', async () => {
    const result = await newService().search({ query: 'https://drive.google.com/drive/my-drive' })

    expect(jsonOf(result)).toEqual({
      error: 'Invalid Drive URL. Please provide a valid Google Drive URL or a search query.',
      details: 'Could not extract file or folder ID from the provided URL.'
    })
    expect(filesGet).not.toHaveBeenCalled()
    expect(filesList).not.toHaveBeenCalled()
  })

  it('searches for text that is not a URL as full text even if it contains a Drive hostname', async () => {
    await newService().search({ query: 'notes about drive.google.com' })

    expect(filesList).toHaveBeenCalledWith(
      expect.objectContaining({ q: "fullText contains 'notes about drive.google.com'" })
    )
    expect(filesGet).not.toHaveBeenCalled()
  })
})

describe('DriveService.trashFile and renameFile', () => {
  beforeEach(() => {
    resetMocks()
  })

  it('trashes a file by ID and reports it as trashed', async () => {
    filesUpdate.mockResolvedValue({ data: { id: 'doc-1', name: 'Old plan' } })

    const result = await newService().trashFile({ fileId: 'doc-1' })

    expect(filesUpdate).toHaveBeenCalledWith({
      fileId: 'doc-1',
      requestBody: { trashed: true },
      fields: 'id, name',
      supportsAllDrives: true
    })
    expect(jsonOf(result)).toEqual({ id: 'doc-1', name: 'Old plan', trashed: true })
    expect(isErrorOf(result)).toBeUndefined()
  })

  it('extracts the file ID from a Docs URL before trashing', async () => {
    filesUpdate.mockResolvedValue({ data: { id: URL_ID, name: 'Doc' } })

    await newService().trashFile({ fileId: `https://docs.google.com/document/d/${URL_ID}/edit` })

    expect(filesUpdate).toHaveBeenCalledWith(expect.objectContaining({ fileId: URL_ID }))
  })

  it('refuses an invalid file ID without calling the API', async () => {
    const result = await newService().trashFile({ fileId: 'not a valid id!' })

    expect(isErrorOf(result)).toBe(true)
    expect(jsonOf(result)).toEqual({ error: 'Invalid document ID or URL' })
    expect(filesUpdate).not.toHaveBeenCalled()
  })

  it('returns the API error message when trashing fails', async () => {
    filesUpdate.mockRejectedValue(new Error('forbidden'))

    const result = await newService().trashFile({ fileId: 'doc-1' })

    expect(isErrorOf(result)).toBe(true)
    expect(jsonOf(result)).toEqual({ error: 'forbidden' })
  })

  it('renames a file and returns its new name', async () => {
    filesUpdate.mockResolvedValue({ data: { id: 'doc-1', name: 'New name' } })

    const result = await newService().renameFile({ fileId: 'doc-1', newName: 'New name' })

    expect(filesUpdate).toHaveBeenCalledWith({
      fileId: 'doc-1',
      requestBody: { name: 'New name' },
      fields: 'id, name',
      supportsAllDrives: true
    })
    expect(jsonOf(result)).toEqual({ id: 'doc-1', name: 'New name' })
  })

  it('extracts the file ID from a URL before renaming', async () => {
    filesUpdate.mockResolvedValue({ data: { id: URL_ID, name: 'Renamed' } })

    await newService().renameFile({
      fileId: `https://docs.google.com/spreadsheets/d/${URL_ID}/edit`,
      newName: 'Renamed'
    })

    expect(filesUpdate).toHaveBeenCalledWith(expect.objectContaining({ fileId: URL_ID }))
  })

  it('refuses to rename an invalid file ID without calling the API', async () => {
    const result = await newService().renameFile({ fileId: 'bad id', newName: 'x' })

    expect(isErrorOf(result)).toBe(true)
    expect(jsonOf(result)).toEqual({ error: 'Invalid document ID or URL' })
    expect(filesUpdate).not.toHaveBeenCalled()
  })

  it('returns the API error message when renaming fails', async () => {
    filesUpdate.mockRejectedValue(new Error('name conflict'))

    const result = await newService().renameFile({ fileId: 'doc-1', newName: 'x' })

    expect(isErrorOf(result)).toBe(true)
    expect(jsonOf(result)).toEqual({ error: 'name conflict' })
  })
})

describe('DriveService.getComments pagination', () => {
  const comment = (id: string) => ({
    id,
    content: `comment ${id}`,
    author: { displayName: 'Alice', emailAddress: 'alice@example.com' },
    createdTime: '2025-01-01T00:00:00Z',
    resolved: false
  })

  beforeEach(() => {
    resetMocks()
  })

  it('forwards pageSize and pageToken and returns the next page cursor with the comments', async () => {
    commentsList.mockResolvedValue({ data: { comments: [comment('c1')], nextPageToken: 'tok-2' } })

    const result = await newService().getComments({ fileId: 'doc-1', pageSize: 1, pageToken: 'tok-1' })

    expect(commentsList).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'doc-1', pageSize: 1, pageToken: 'tok-1' })
    )
    expect(jsonOf(result)).toEqual({ comments: [comment('c1')], nextPageToken: 'tok-2' })
  })

  it('returns an object with the cursor, never a bare comment array', async () => {
    commentsList.mockResolvedValue({ data: { comments: [comment('c1')], nextPageToken: 'tok-2' } })

    const parsed = jsonOf(await newService().getComments({ fileId: 'doc-1' }))

    expect(Array.isArray(parsed)).toBe(false)
    expect(parsed).toHaveProperty('nextPageToken', 'tok-2')
  })

  it('requests the cursor in the fields mask so the API can return it', async () => {
    commentsList.mockResolvedValue({ data: { comments: [] } })

    await newService().getComments({ fileId: 'doc-1' })

    const { fields } = commentsList.mock.calls[0][0]
    expect(fields).toMatch(/^nextPageToken, comments\(/)
    expect(fields).toContain('replies(')
    expect(fields).toContain('quotedFileContent(value)')
  })

  it('leaves pageSize and pageToken out of the request when the caller omits them', async () => {
    commentsList.mockResolvedValue({ data: { comments: [] } })

    await newService().getComments({ fileId: 'doc-1' })

    const request = commentsList.mock.calls[0][0]
    expect(request.fileId).toBe('doc-1')
    expect(request).not.toHaveProperty('pageSize')
    expect(request).not.toHaveProperty('pageToken')
  })

  it('forwards only the pageToken when pageSize is omitted', async () => {
    commentsList.mockResolvedValue({ data: { comments: [] } })

    await newService().getComments({ fileId: 'doc-1', pageToken: 'tok-9' })

    const request = commentsList.mock.calls[0][0]
    expect(request.pageToken).toBe('tok-9')
    expect(request).not.toHaveProperty('pageSize')
  })

  it('reports a null cursor on the last page', async () => {
    commentsList.mockResolvedValue({ data: { comments: [comment('c2')] } })

    const parsed = jsonOf(await newService().getComments({ fileId: 'doc-1' }))

    expect(parsed).toEqual({ comments: [comment('c2')], nextPageToken: null })
  })

  it('returns an empty comment list when the API response has no comments field', async () => {
    commentsList.mockResolvedValue({ data: {} })

    const parsed = jsonOf(await newService().getComments({ fileId: 'doc-1' }))

    expect(parsed).toEqual({ comments: [], nextPageToken: null })
  })

  it('serializes the page as pretty-printed JSON', async () => {
    commentsList.mockResolvedValue({ data: { comments: [comment('c1')], nextPageToken: 'tok-2' } })

    const result = await newService().getComments({ fileId: 'doc-1' })

    expect(textOf(result)).toBe(JSON.stringify({ comments: [comment('c1')], nextPageToken: 'tok-2' }, null, 2))
  })

  it('walks every page by feeding each returned cursor into the next request', async () => {
    commentsList
      .mockResolvedValueOnce({ data: { comments: [comment('c1')], nextPageToken: 'tok-2' } })
      .mockResolvedValueOnce({ data: { comments: [comment('c2')] } })
    const service = newService()

    const first = jsonOf(await service.getComments({ fileId: 'doc-1', pageSize: 1 }))
    const second = jsonOf(await service.getComments({ fileId: 'doc-1', pageSize: 1, pageToken: first.nextPageToken }))

    expect(commentsList).toHaveBeenNthCalledWith(2, expect.objectContaining({ pageSize: 1, pageToken: 'tok-2' }))
    expect([...first.comments, ...second.comments]).toEqual([comment('c1'), comment('c2')])
    expect(second.nextPageToken).toBeNull()
  })

  it('extracts the file ID from a URL before listing comments', async () => {
    commentsList.mockResolvedValue({ data: { comments: [] } })

    await newService().getComments({ fileId: `https://docs.google.com/document/d/${URL_ID}/edit` })

    expect(commentsList).toHaveBeenCalledWith(expect.objectContaining({ fileId: URL_ID }))
  })

  it('refuses an invalid file ID without calling the API', async () => {
    const result = await newService().getComments({ fileId: 'bad id' })

    expect(isErrorOf(result)).toBe(true)
    expect(jsonOf(result)).toEqual({ error: 'Invalid document ID or URL' })
    expect(commentsList).not.toHaveBeenCalled()
  })

  it('returns the API error message when listing comments fails', async () => {
    commentsList.mockRejectedValue(new Error('comments disabled'))

    const result = await newService().getComments({ fileId: 'doc-1' })

    expect(isErrorOf(result)).toBe(true)
    expect(jsonOf(result)).toEqual({ error: 'comments disabled' })
  })
})

describe('DriveService.moveFile', () => {
  beforeEach(() => {
    resetMocks()
    filesGet.mockResolvedValue({ data: { parents: ['old-1', 'old-2'] } })
    filesUpdate.mockResolvedValue({ data: { id: 'doc-1', name: 'Plan', parents: ['dest-1'] } })
  })

  it('moves a file to the given folder ID and drops every previous parent', async () => {
    const result = await newService().moveFile({ fileId: 'doc-1', folderId: 'dest-1' })

    expect(filesGet).toHaveBeenCalledWith({ fileId: 'doc-1', fields: 'parents', supportsAllDrives: true })
    expect(filesUpdate).toHaveBeenCalledWith({
      fileId: 'doc-1',
      addParents: 'dest-1',
      removeParents: 'old-1,old-2',
      fields: 'id, name, parents',
      supportsAllDrives: true
    })
    expect(filesList).not.toHaveBeenCalled()
    expect(jsonOf(result)).toEqual({ id: 'doc-1', name: 'Plan', parents: ['dest-1'] })
  })

  it('does not ask to remove parents when the file has none', async () => {
    filesGet.mockResolvedValue({ data: {} })

    await newService().moveFile({ fileId: 'doc-1', folderId: 'dest-1' })

    expect(filesUpdate.mock.calls[0][0].removeParents).toBeUndefined()
    expect(filesUpdate.mock.calls[0][0].addParents).toBe('dest-1')
  })

  it('prefers folderId over folderName and never searches for the name', async () => {
    await newService().moveFile({ fileId: 'doc-1', folderId: 'dest-1', folderName: 'Other' })

    expect(filesList).not.toHaveBeenCalled()
    expect(filesUpdate).toHaveBeenCalledWith(expect.objectContaining({ addParents: 'dest-1' }))
  })

  it('resolves a unique folder name to its ID before moving', async () => {
    filesList.mockResolvedValue({ data: { files: [{ id: 'dest-7', name: 'Reports' }] } })

    await newService().moveFile({ fileId: 'doc-1', folderName: 'Reports' })

    expect(filesList).toHaveBeenCalledWith(
      expect.objectContaining({ q: `mimeType='${FOLDER_MIME}' and name = 'Reports'` })
    )
    expect(filesUpdate).toHaveBeenCalledWith(expect.objectContaining({ addParents: 'dest-7' }))
  })

  it('uses the first folder when several share the requested name', async () => {
    filesList.mockResolvedValue({
      data: {
        files: [
          { id: 'first', name: 'Reports' },
          { id: 'second', name: 'Reports' }
        ]
      }
    })

    await newService().moveFile({ fileId: 'doc-1', folderName: 'Reports' })

    expect(filesUpdate).toHaveBeenCalledWith(expect.objectContaining({ addParents: 'first' }))
  })

  it('fails without moving anything when no folder has the requested name', async () => {
    filesList.mockResolvedValue({ data: { files: [] } })

    const result = await newService().moveFile({ fileId: 'doc-1', folderName: 'Ghost' })

    expect(isErrorOf(result)).toBe(true)
    expect(jsonOf(result)).toEqual({ error: 'Folder not found: Ghost' })
    expect(filesUpdate).not.toHaveBeenCalled()
  })

  it('surfaces the folder lookup error instead of moving the file', async () => {
    filesList.mockRejectedValue(new Error('quota exceeded'))

    const result = await newService().moveFile({ fileId: 'doc-1', folderName: 'Reports' })

    expect(isErrorOf(result)).toBe(true)
    expect(jsonOf(result)).toEqual({ error: 'quota exceeded' })
    expect(filesUpdate).not.toHaveBeenCalled()
  })

  it.each([[{}], [{ folderName: '' }]])('requires a folder ID or a folder name (%j)', async (target) => {
    const result = await newService().moveFile({ fileId: 'doc-1', ...target })

    expect(isErrorOf(result)).toBe(true)
    expect(jsonOf(result)).toEqual({ error: 'Either folderId or folderName must be provided.' })
    expect(filesGet).not.toHaveBeenCalled()
    expect(filesUpdate).not.toHaveBeenCalled()
  })

  it('refuses an invalid file ID without calling the API', async () => {
    const result = await newService().moveFile({ fileId: 'bad id', folderId: 'dest-1' })

    expect(jsonOf(result)).toEqual({ error: 'Invalid document ID or URL' })
    expect(filesUpdate).not.toHaveBeenCalled()
  })

  it('returns the API error message when reading the current parents fails', async () => {
    filesGet.mockRejectedValue(new Error('file not found'))

    const result = await newService().moveFile({ fileId: 'doc-1', folderId: 'dest-1' })

    expect(isErrorOf(result)).toBe(true)
    expect(jsonOf(result)).toEqual({ error: 'file not found' })
    expect(filesUpdate).not.toHaveBeenCalled()
  })

  it('returns the API error message when the move itself fails', async () => {
    filesUpdate.mockRejectedValue(new Error('move denied'))

    const result = await newService().moveFile({ fileId: 'doc-1', folderId: 'dest-1' })

    expect(isErrorOf(result)).toBe(true)
    expect(jsonOf(result)).toEqual({ error: 'move denied' })
  })
})

describe('DriveService.downloadFile Google-native and failure handling', () => {
  const pdfBytes = new Uint8Array([1, 2, 3]).buffer

  beforeEach(() => {
    resetMocks()
    mkdir.mockResolvedValue(undefined)
    writeFile.mockResolvedValue(undefined)
  })

  it.each([
    ['application/vnd.google-apps.document', 'Google Doc', 'docs.getText', 'documentId'],
    ['application/vnd.google-apps.spreadsheet', 'Google Sheet', 'sheets.getText', 'spreadsheetId'],
    ['application/vnd.google-apps.presentation', 'Google Slide', 'slides.getText', 'presentationId']
  ])('points %s at the %s text tool instead of downloading', async (mimeType, type, tool, idName) => {
    filesGet.mockResolvedValue({ data: { id: 'doc-1', name: 'Native', mimeType } })

    const result = await newService().downloadFile({ fileId: 'doc-1', localPath: 'out/native.bin' })

    expect(textOf(result)).toBe(
      `This is a ${type}. Direct download is not supported. Please use the '${tool}' tool with ${idName}: doc-1`
    )
    expect(filesGet).toHaveBeenCalledTimes(1)
    expect(filesGet).toHaveBeenCalledWith({ fileId: 'doc-1', fields: 'id, name, mimeType', supportsAllDrives: true })
    expect(writeFile).not.toHaveBeenCalled()
  })

  it.each([
    'application/vnd.google-apps.form',
    'application/vnd.google-apps.folder',
    'application/vnd.google-apps.drawing'
  ])('explains that the Google Workspace type %s cannot be downloaded as media', async (mimeType) => {
    filesGet.mockResolvedValue({ data: { id: 'doc-1', name: 'Native', mimeType } })

    const result = await newService().downloadFile({ fileId: 'doc-1', localPath: 'out/native.bin' })

    expect(textOf(result)).toBe(
      `This is a Google Workspace file type (${mimeType}). Direct media download is not supported. Please use specific tools (docs.getText, slides.getText, etc.) or export it if supported.`
    )
    expect(filesGet).toHaveBeenCalledTimes(1)
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('downloads the media as an arraybuffer and writes the exact bytes', async () => {
    filesGet
      .mockResolvedValueOnce({ data: { id: 'doc-1', name: 'report.pdf', mimeType: 'application/pdf' } })
      .mockResolvedValueOnce({ data: pdfBytes })
    const expectedPath = path.resolve(PROJECT_ROOT, 'out', 'report.pdf')

    const result = await newService().downloadFile({ fileId: 'doc-1', localPath: 'out/report.pdf' })

    expect(filesGet).toHaveBeenNthCalledWith(
      2,
      { fileId: 'doc-1', alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    )
    expect(mkdir).toHaveBeenCalledWith(path.dirname(expectedPath), { recursive: true })
    expect(writeFile).toHaveBeenCalledWith(expectedPath, Buffer.from([1, 2, 3]))
    expect(textOf(result)).toBe(`Successfully downloaded file report.pdf to ${expectedPath}`)
  })

  it('downloads a file whose metadata has no mimeType as plain media', async () => {
    filesGet.mockResolvedValueOnce({ data: { id: 'doc-1', name: 'blob' } }).mockResolvedValueOnce({ data: pdfBytes })

    const result = await newService().downloadFile({ fileId: 'doc-1', localPath: 'blob.bin' })

    expect(writeFile).toHaveBeenCalledWith(path.resolve(PROJECT_ROOT, 'blob.bin'), Buffer.from([1, 2, 3]))
    expect(textOf(result)).toContain('Successfully downloaded file blob')
  })

  it('extracts the file ID from a URL before downloading', async () => {
    filesGet.mockResolvedValue({ data: { id: URL_ID, name: 'Doc', mimeType: 'application/vnd.google-apps.document' } })

    const result = await newService().downloadFile({
      fileId: `https://docs.google.com/document/d/${URL_ID}/edit`,
      localPath: 'doc.txt'
    })

    expect(filesGet).toHaveBeenCalledWith(expect.objectContaining({ fileId: URL_ID }))
    expect(textOf(result)).toContain(`documentId: ${URL_ID}`)
  })

  it('refuses an invalid file ID without calling the API', async () => {
    const result = await newService().downloadFile({ fileId: 'bad id', localPath: 'x.bin' })

    expect(jsonOf(result)).toEqual({ error: 'Invalid document ID or URL' })
    expect(filesGet).not.toHaveBeenCalled()
  })

  it('returns the API error message when the metadata lookup fails', async () => {
    filesGet.mockRejectedValue(new Error('file not found'))

    const result = await newService().downloadFile({ fileId: 'doc-1', localPath: 'x.bin' })

    expect(jsonOf(result)).toEqual({ error: 'file not found' })
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('returns the API error message when the media download fails and writes nothing', async () => {
    filesGet
      .mockResolvedValueOnce({ data: { id: 'doc-1', name: 'report.pdf', mimeType: 'application/pdf' } })
      .mockRejectedValueOnce(new Error('download interrupted'))

    const result = await newService().downloadFile({ fileId: 'doc-1', localPath: 'x.bin' })

    expect(jsonOf(result)).toEqual({ error: 'download interrupted' })
    expect(mkdir).not.toHaveBeenCalled()
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('stringifies a non-Error rejection from the metadata lookup', async () => {
    filesGet.mockRejectedValue('network down')

    const result = await newService().downloadFile({ fileId: 'doc-1', localPath: 'x.bin' })

    expect(jsonOf(result)).toEqual({ error: 'network down' })
  })

  it('returns the filesystem error when the destination directory cannot be created', async () => {
    filesGet
      .mockResolvedValueOnce({ data: { id: 'doc-1', name: 'report.pdf', mimeType: 'application/pdf' } })
      .mockResolvedValueOnce({ data: pdfBytes })
    mkdir.mockRejectedValue(new Error('EACCES: permission denied'))

    const result = await newService().downloadFile({ fileId: 'doc-1', localPath: 'locked/x.bin' })

    expect(jsonOf(result)).toEqual({ error: 'EACCES: permission denied' })
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('returns the filesystem error when the file cannot be written', async () => {
    filesGet
      .mockResolvedValueOnce({ data: { id: 'doc-1', name: 'report.pdf', mimeType: 'application/pdf' } })
      .mockResolvedValueOnce({ data: pdfBytes })
    writeFile.mockRejectedValue(new Error('ENOSPC: no space left on device'))

    const result = await newService().downloadFile({ fileId: 'doc-1', localPath: 'x.bin' })

    expect(jsonOf(result)).toEqual({ error: 'ENOSPC: no space left on device' })
  })
})

describe('DriveService.downloadFile path traversal guard', () => {
  const pdfMetadata = { data: { id: 'doc-1', name: 'report.pdf', mimeType: 'application/pdf' } }
  const sep = path.sep

  beforeEach(() => {
    resetMocks()
    mkdir.mockResolvedValue(undefined)
    writeFile.mockResolvedValue(undefined)
    filesGet.mockResolvedValueOnce(pdfMetadata).mockResolvedValueOnce({ data: new Uint8Array([9]).buffer })
  })

  it.each([
    ['a parent-directory segment', () => ['..', 'escape.bin'].join(sep)],
    ['a traversal hidden behind a subdirectory', () => ['sub', '..', '..', 'escape.bin'].join(sep)],
    ['a traversal that climbs well past the filesystem root', () => [...Array(40).fill('..'), 'escape.bin'].join(sep)],
    ['an absolute path beside the project root', () => path.resolve(PROJECT_ROOT, '..', 'escape.bin')],
    // Not normalized: the path starts with the project root and then climbs out of it.
    ['an absolute path that climbs out through a dot-dot segment', () => `${PROJECT_ROOT}${sep}..${sep}escape.bin`],
    [
      'an absolute sibling that shares the root directory name as a prefix',
      () => `${PROJECT_ROOT}-sibling${sep}escape.bin`
    ],
    ['the parent of the project root', () => path.dirname(PROJECT_ROOT)]
  ])('rejects %s before downloading anything or touching the filesystem', async (_label, makePath) => {
    const result = await newService().downloadFile({ fileId: 'doc-1', localPath: makePath() })

    expect(jsonOf(result)).toEqual({ error: 'localPath must be within the project root.' })
    expect(filesGet).not.toHaveBeenCalled()
    expect(mkdir).not.toHaveBeenCalled()
    expect(writeFile).not.toHaveBeenCalled()
  })

  // `path.relative` has no `..` route between two drives and returns the target as is.
  it.runIf(process.platform === 'win32')('rejects an absolute path on another drive', async () => {
    const otherDrive = PROJECT_ROOT.toUpperCase().startsWith('Z:') ? 'Y:' : 'Z:'

    const result = await newService().downloadFile({ fileId: 'doc-1', localPath: `${otherDrive}\\escape.bin` })

    expect(jsonOf(result)).toEqual({ error: 'localPath must be within the project root.' })
    expect(filesGet).not.toHaveBeenCalled()
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('allows a relative path whose dot-dot segments stay inside the project root', async () => {
    const result = await newService().downloadFile({
      fileId: 'doc-1',
      localPath: ['a', '..', 'kept.bin'].join(sep)
    })

    const expectedPath = path.join(PROJECT_ROOT, 'kept.bin')
    expect(writeFile).toHaveBeenCalledWith(expectedPath, Buffer.from([9]))
    expect(textOf(result)).toBe(`Successfully downloaded file report.pdf to ${expectedPath}`)
  })

  it('creates nested destination directories recursively under the project root', async () => {
    await newService().downloadFile({ fileId: 'doc-1', localPath: ['deep', 'er', 'file.bin'].join(sep) })

    const expectedDir = path.join(PROJECT_ROOT, 'deep', 'er')
    expect(mkdir).toHaveBeenCalledWith(expectedDir, { recursive: true })
    expect(writeFile).toHaveBeenCalledWith(path.join(expectedDir, 'file.bin'), expect.any(Buffer))
  })

  it('treats the project root itself as inside the boundary', async () => {
    await newService().downloadFile({ fileId: 'doc-1', localPath: PROJECT_ROOT })

    expect(writeFile).toHaveBeenCalledWith(PROJECT_ROOT, expect.any(Buffer))
  })
})

describe('DriveService.downloadFile on a real filesystem', () => {
  // The project root is a subdirectory of a mkdtemp container, so even a broken guard can only
  // spill into the container, which afterEach removes together with the project root.
  let container: string
  let tmpRoot: string
  let realPromises: typeof fs.promises

  beforeAll(async () => {
    realPromises = (await vi.importActual<typeof import('node:fs')>('node:fs')).promises
  })

  beforeEach(() => {
    resetMocks()
    container = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-download-'))
    tmpRoot = path.join(container, 'project')
    fs.mkdirSync(tmpRoot)
    projectRoot.override = tmpRoot
    mkdir.mockImplementation((dir: string, options: any) => realPromises.mkdir(dir, options))
    writeFile.mockImplementation((file: string, data: Buffer) => realPromises.writeFile(file, data))
    filesGet
      .mockResolvedValueOnce({ data: { id: 'doc-1', name: 'report.pdf', mimeType: 'application/pdf' } })
      .mockResolvedValueOnce({ data: new Uint8Array([1, 2, 3, 250]).buffer })
  })

  afterEach(() => {
    projectRoot.override = undefined
    fs.rmSync(container, { recursive: true, force: true })
  })

  // A file symlink needs Developer Mode or an elevated shell on Windows: without either the test
  // is skipped, not failed. Directory links below are junctions, which need neither.
  function fileLink(ctx: TestContext, target: string, link: string): void {
    try {
      fs.symlinkSync(target, link, 'file')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') ctx.skip('creating a file symlink needs privileges here')
      throw error
    }
  }

  it('writes the downloaded bytes to a nested relative path, creating the missing directories', async () => {
    const localPath = ['out', 'nested', 'report.pdf'].join(path.sep)
    const expectedPath = path.join(tmpRoot, 'out', 'nested', 'report.pdf')

    const result = await newService().downloadFile({ fileId: 'doc-1', localPath })

    expect(textOf(result)).toBe(`Successfully downloaded file report.pdf to ${expectedPath}`)
    expect(fs.readFileSync(expectedPath)).toEqual(Buffer.from([1, 2, 3, 250]))
  })

  it('writes to an absolute destination inside the project root', async () => {
    const expectedPath = path.join(tmpRoot, 'absolute.bin')

    await newService().downloadFile({ fileId: 'doc-1', localPath: expectedPath })

    expect(fs.readFileSync(expectedPath)).toEqual(Buffer.from([1, 2, 3, 250]))
  })

  it('overwrites a file that already exists at the destination', async () => {
    const expectedPath = path.join(tmpRoot, 'existing.bin')
    fs.writeFileSync(expectedPath, 'previous content that is much longer than the new payload')

    await newService().downloadFile({ fileId: 'doc-1', localPath: 'existing.bin' })

    expect(fs.readFileSync(expectedPath)).toEqual(Buffer.from([1, 2, 3, 250]))
  })

  it('does not write outside the project root when the path escapes it', async () => {
    const escaped = path.join(container, 'escape.bin')

    const result = await newService().downloadFile({
      fileId: 'doc-1',
      localPath: ['..', 'escape.bin'].join(path.sep)
    })

    expect(jsonOf(result)).toEqual({ error: 'localPath must be within the project root.' })
    expect(fs.existsSync(escaped)).toBe(false)
    expect(fs.readdirSync(tmpRoot)).toEqual([])
  })

  it('refuses a destination outside the project root by name, without inspecting the filesystem', async () => {
    // Resolving the outside part would surface its errors (EACCES, ENOTDIR, ELOOP) to the caller.
    const realpath = vi.spyOn(mockedFs.promises, 'realpath')
    const lstat = vi.spyOn(mockedFs.promises, 'lstat')
    try {
      for (const localPath of [['..', 'outside', 'x.bin'].join(path.sep), path.join(container, 'outside', 'x.bin')]) {
        const result = await newService().downloadFile({ fileId: 'doc-1', localPath })

        expect(jsonOf(result), localPath).toEqual({ error: 'localPath must be within the project root.' })
      }
      expect(realpath).not.toHaveBeenCalled()
      expect(lstat).not.toHaveBeenCalled()
      expect(filesGet).not.toHaveBeenCalled()
    } finally {
      realpath.mockRestore()
      lstat.mockRestore()
    }
  })

  // A junction, not a directory symlink: Windows creates one without extra privileges.
  it('does not write through a directory link inside the project root that points outside it', async () => {
    const outside = path.join(container, 'outside')
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(tmpRoot, 'link'), 'junction')

    const result = await newService().downloadFile({
      fileId: 'doc-1',
      localPath: ['link', 'nested', 'escape.bin'].join(path.sep)
    })

    expect(jsonOf(result)).toEqual({ error: 'localPath must be within the project root.' })
    expect(filesGet).not.toHaveBeenCalled()
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it('does not overwrite a file outside the project root through a file symlink inside it', async (ctx) => {
    const outside = path.join(container, 'outside.bin')
    fs.writeFileSync(outside, 'kept')
    fileLink(ctx, outside, path.join(tmpRoot, 'alias.bin'))

    const result = await newService().downloadFile({ fileId: 'doc-1', localPath: 'alias.bin' })

    expect(jsonOf(result)).toEqual({ error: 'localPath must be within the project root.' })
    expect(fs.readFileSync(outside, 'utf8')).toBe('kept')
  })

  // Writing through a link whose target is missing creates that target, wherever it points.
  it('does not create a file through a dangling link, whatever its target or chain', async (ctx) => {
    fileLink(ctx, path.join(container, 'new.bin'), path.join(tmpRoot, 'new.bin'))
    fileLink(ctx, path.join('..', 'relative.bin'), path.join(tmpRoot, 'relative.bin'))
    fileLink(ctx, path.join(container, 'two.bin'), path.join(tmpRoot, 'second.bin'))
    fileLink(ctx, path.join(tmpRoot, 'second.bin'), path.join(tmpRoot, 'first.bin'))

    for (const localPath of ['new.bin', 'relative.bin', 'first.bin']) {
      const result = await newService().downloadFile({ fileId: 'doc-1', localPath })

      expect(jsonOf(result), localPath).toEqual({
        error: 'localPath must not go through a link whose target does not exist.'
      })
    }
    expect(filesGet).not.toHaveBeenCalled()
    expect(fs.readdirSync(container)).toEqual(['project'])
  })

  it('refuses a dangling directory link on the way to the destination before downloading anything', async () => {
    const missing = path.join(container, 'missing')
    fs.symlinkSync(missing, path.join(tmpRoot, 'gone'), 'junction')

    const result = await newService().downloadFile({ fileId: 'doc-1', localPath: ['gone', 'x.bin'].join(path.sep) })

    expect(jsonOf(result)).toEqual({ error: 'localPath must not go through a link whose target does not exist.' })
    expect(filesGet).not.toHaveBeenCalled()
    expect(fs.existsSync(missing)).toBe(false)
  })

  it('reports a failure to inspect a missing component instead of treating it as absent', async () => {
    // DriveService reads fs.promises from the mocked module; the spy replaces lstat there only.
    const denied = Object.assign(new Error('EACCES: permission denied, lstat'), { code: 'EACCES' })
    const lstat = vi.spyOn(mockedFs.promises, 'lstat').mockRejectedValueOnce(denied)
    try {
      const result = await newService().downloadFile({ fileId: 'doc-1', localPath: ['missing', 'x.bin'].join(path.sep) })

      expect(jsonOf(result)).toEqual({ error: 'EACCES: permission denied, lstat' })
      expect(filesGet).not.toHaveBeenCalled()
    } finally {
      lstat.mockRestore()
    }
  })

  it('checks the destination again after the download, before it writes', async () => {
    const outside = path.join(container, 'outside')
    fs.mkdirSync(outside)
    filesGet.mockReset()
    filesGet
      .mockResolvedValueOnce({ data: { id: 'doc-1', name: 'report.pdf', mimeType: 'application/pdf' } })
      .mockImplementationOnce(async () => {
        // The first check passed on a missing `late`; it becomes a link out while the bytes download.
        fs.symlinkSync(outside, path.join(tmpRoot, 'late'), 'junction')
        return { data: new Uint8Array([1, 2, 3, 250]).buffer }
      })

    const result = await newService().downloadFile({ fileId: 'doc-1', localPath: ['late', 'x.bin'].join(path.sep) })

    expect(jsonOf(result)).toEqual({ error: 'localPath must be within the project root.' })
    expect(filesGet).toHaveBeenCalledTimes(2)
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it('refuses a destination it cannot resolve, through a link loop, before downloading anything', async (ctx) => {
    const loop = path.join(tmpRoot, 'loop')
    fileLink(ctx, loop, loop)

    const result = await newService().downloadFile({ fileId: 'doc-1', localPath: ['loop', 'x.bin'].join(path.sep) })

    expect(jsonOf(result).error).toMatch(/ELOOP/)
    expect(filesGet).not.toHaveBeenCalled()
  })

  it('still writes through a directory link that stays inside the project root', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'real'))
    fs.symlinkSync(path.join(tmpRoot, 'real'), path.join(tmpRoot, 'alias'), 'junction')

    await newService().downloadFile({ fileId: 'doc-1', localPath: ['alias', 'kept.bin'].join(path.sep) })

    expect(fs.readFileSync(path.join(tmpRoot, 'real', 'kept.bin'))).toEqual(Buffer.from([1, 2, 3, 250]))
  })

  it('still overwrites a file through a file symlink that stays inside the project root', async (ctx) => {
    const target = path.join(tmpRoot, 'target.bin')
    fs.writeFileSync(target, 'previous')
    fileLink(ctx, target, path.join(tmpRoot, 'alias.bin'))

    await newService().downloadFile({ fileId: 'doc-1', localPath: 'alias.bin' })

    expect(fs.readFileSync(target)).toEqual(Buffer.from([1, 2, 3, 250]))
    expect(fs.lstatSync(path.join(tmpRoot, 'alias.bin')).isSymbolicLink()).toBe(true)
  })

  it('returns an error result and keeps the blocking file when a parent directory is a regular file', async () => {
    const blocker = path.join(tmpRoot, 'blocker')
    fs.writeFileSync(blocker, 'not a directory')

    const result = await newService().downloadFile({
      fileId: 'doc-1',
      localPath: ['blocker', 'child.bin'].join(path.sep)
    })

    expect(typeof jsonOf(result).error).toBe('string')
    expect(jsonOf(result).error).not.toContain('within the project root')
    expect(fs.readFileSync(blocker, 'utf8')).toBe('not a directory')
  })
})
