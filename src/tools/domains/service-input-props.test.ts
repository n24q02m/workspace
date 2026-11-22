import { describe, expect, it } from 'vitest'
import { serviceInputProps } from './service-input-props.js'

// A stand-in for a vendored service: one action reads an input object, one reads nothing.
class FakeService {
  listThings = async (_input: {
    folderId: string
    pageSize?: number
    tags?: string[]
    window?: { start: string }
    mode?: 'fast' | 'full'
    archived?: boolean
  }) => ({ content: [] })
  ping = async () => ({ content: [] })
}
const FAKE_ACTIONS = ['listThings', 'ping'] as const
const fakeProps = serviceInputProps<FakeService, typeof FAKE_ACTIONS>()

// A parameter typed as a union of JSON shapes, as Gmail's recipients are.
class FakeMailer {
  send = async (_input: { to: string | string[] }) => ({ content: [] })
}
const MAILER_ACTIONS = ['send'] as const
const mailerProps = serviceInputProps<FakeMailer, typeof MAILER_ACTIONS>()

// The checks below are type-level: `bun run type-check` fails when a
// `@ts-expect-error` line stops being an error, so a helper that no longer
// rejects a gap turns the check red. The `it` bodies run the same calls so
// the runtime contract (the props come back untouched) is covered too.
describe('serviceInputProps', () => {
  it('returns the schema properties it was given, extra tool-level ones included', () => {
    const props = {
      folderId: { type: 'string' },
      pageSize: { type: 'integer' },
      tags: { type: 'array', items: { type: 'string' } },
      window: { type: 'object' },
      mode: { type: 'string', enum: ['fast', 'full'] },
      archived: { type: 'boolean' },
      max_chars: { type: 'number' }
    } as const
    expect(fakeProps(props)).toBe(props)
  })

  it('accepts schema keywords beyond type in an inline literal', () => {
    // Inline literals get excess-property checks that a declared constant skips.
    const props = fakeProps({
      folderId: { type: 'string', description: 'Folder ID' },
      pageSize: { type: 'number', description: 'Results per page', minimum: 1 },
      tags: { type: 'array', items: { type: 'string' } },
      window: { type: 'object', properties: { start: { type: 'string' } } },
      mode: { type: 'string', enum: ['fast', 'full'] },
      archived: { type: 'boolean' }
    })
    expect(props.folderId.description).toBe('Folder ID')
  })

  it('rejects a schema that leaves out a parameter the service reads', () => {
    const props = {
      folderId: { type: 'string' },
      tags: { type: 'array' },
      window: { type: 'object' },
      mode: { type: 'string' },
      archived: { type: 'boolean' }
    } as const
    // @ts-expect-error -- listThings reads pageSize, which the schema does not advertise
    expect(fakeProps(props)).toBe(props)
  })

  it('rejects a parameter advertised with the wrong JSON type', () => {
    const props = {
      folderId: { type: 'string' },
      pageSize: { type: 'number' },
      tags: { type: 'array' },
      window: { type: 'string' },
      mode: { type: 'string' },
      archived: { type: 'boolean' }
    } as const
    // @ts-expect-error -- window is an object, not a string
    expect(fakeProps(props)).toBe(props)
  })

  it('rejects a parameter that no listed action reads', () => {
    const props = {
      folderId: { type: 'string' },
      pageSize: { type: 'number' },
      tags: { type: 'array' },
      window: { type: 'object' },
      mode: { type: 'string' },
      archived: { type: 'boolean' },
      folder_id: { type: 'string' }
    } as const
    // @ts-expect-error -- no action reads folder_id, so a client that sends it is ignored
    expect(fakeProps(props)).toBe(props)
  })

  it('accepts a union parameter advertised with anyOf over each of its JSON types', () => {
    const props = mailerProps({
      to: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Recipients' }
    })
    expect(props.to.description).toBe('Recipients')
  })

  it('rejects a union parameter advertised with only one of its JSON types', () => {
    const props = { to: { type: 'string' } } as const
    // @ts-expect-error -- send also takes an array of addresses, which the schema forbids
    expect(mailerProps(props)).toBe(props)
  })

  it('rejects an anyOf that leaves out one of the parameter JSON types', () => {
    const props = { to: { anyOf: [{ type: 'array' }] } } as const
    // @ts-expect-error -- send also takes a single address string, which the schema forbids
    expect(mailerProps(props)).toBe(props)
  })

  it('rejects an anyOf branch with a JSON type the parameter cannot have', () => {
    const props = { to: { anyOf: [{ type: 'string' }, { type: 'array' }, { type: 'object' }] } } as const
    // @ts-expect-error -- to is never an object
    expect(mailerProps(props)).toBe(props)
  })
})
