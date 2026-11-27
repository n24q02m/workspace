import { CLIENT_CAPABILITIES_META_KEY, type ServerContext } from '@modelcontextprotocol/server'
import { FILES_EXTENSION_ID } from '@n24q02m/hull/extensions'
import { describe, expect, it } from 'vitest'
import {
  clientSupportsFilesExtension,
  currentMcpContext,
  getActiveClientCapabilities,
  runWithMcpContext
} from './mcp-context.js'

describe('mcp-context AsyncLocalStorage helpers', () => {
  it('returns undefined outside runWithMcpContext and passes through when ctx is omitted', async () => {
    expect(currentMcpContext()).toBeUndefined()
    expect(clientSupportsFilesExtension()).toBe(false)

    const result = await runWithMcpContext(undefined, async () => currentMcpContext())
    expect(result).toBeUndefined()
  })

  it('propagates clientCapabilities and evaluates io.modelcontextprotocol/files support', async () => {
    const supported = await runWithMcpContext(
      { clientCapabilities: { extensions: { [FILES_EXTENSION_ID]: {} } } },
      async () => clientSupportsFilesExtension()
    )
    expect(supported).toBe(true)

    const disabled = await runWithMcpContext(
      { clientCapabilities: { extensions: { [FILES_EXTENSION_ID]: false } } as never },
      async () => clientSupportsFilesExtension()
    )
    expect(disabled).toBe(false)

    const absent = await runWithMcpContext({ clientCapabilities: { extensions: {} } }, async () =>
      clientSupportsFilesExtension()
    )
    expect(absent).toBe(false)
  })

  it('prefers 2026-07-28 envelope client capabilities over initialize capabilities', async () => {
    const fakeServerCtx = {
      mcpReq: {
        envelope: {
          [CLIENT_CAPABILITIES_META_KEY]: {
            extensions: { [FILES_EXTENSION_ID]: { maxSizeBytes: 1024 } }
          }
        }
      }
    } as unknown as ServerContext

    const caps = await runWithMcpContext(
      {
        serverContext: fakeServerCtx,
        clientCapabilities: { extensions: {} }
      },
      async () => ({
        caps: getActiveClientCapabilities(),
        files: clientSupportsFilesExtension()
      })
    )
    expect(caps.files).toBe(true)
    expect(caps.caps?.extensions).toHaveProperty(FILES_EXTENSION_ID)
  })
})
