import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'
import { attachWorkspaceSkills, loadWorkspaceSkillsCatalog, resolveSkillsDir } from './skills.js'
import { registerTools } from './tools/registry.js'

describe('workspace skills provider', () => {
  it('resolves the packaged skills directory', () => {
    const dir = resolveSkillsDir()
    expect(existsSync(dir)).toBe(true)
    expect(existsSync(join(dir, 'calendar-agenda', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(dir, 'drive-audit', 'SKILL.md'))).toBe(true)
  })

  it('attaches skills alongside workspace://docs/* and serves them to SkillsClient', async () => {
    const catalog = await loadWorkspaceSkillsCatalog()
    const server = new McpServer({ name: 'test-workspace', version: '0.0.0' }, { capabilities: { resources: {} } })
    catalog.attach(server)
    registerTools(server)

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    try {
      const skillsClient = new SkillsClient(client)
      expect(skillsClient.supported).toBe(true)
      const listResult = await skillsClient.list()
      const skillNames = listResult.skills.map((s) => s.frontmatter.name)
      expect(skillNames).toContain('calendar-agenda')
      expect(skillNames).toContain('drive-audit')

      const agenda = await skillsClient.get('skill://calendar-agenda/SKILL.md')
      const agendaFile = await skillsClient.read(agenda.skill)
      expect(agendaFile.verified).toBe(true)
      expect(agendaFile.text).toContain('calendar-agenda')

      const docs = await client.readResource({ uri: 'workspace://docs/calendar' })
      expect(docs.contents[0]).toMatchObject({ uri: 'workspace://docs/calendar', mimeType: 'text/markdown' })
    } finally {
      await Promise.all([client.close(), server.close()])
    }
  })

  it('attachWorkspaceSkills attaches directly to an McpServer instance', async () => {
    const server = new McpServer({ name: 'direct-skills', version: '0.0.0' }, { capabilities: { resources: {} } })
    const catalog = await attachWorkspaceSkills(server)

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'direct-client', version: '0.0.0' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    try {
      const skillsClient = new SkillsClient(client)
      const { skills } = await skillsClient.list()
      expect(skills.map((s) => s.frontmatter.name)).toEqual(expect.arrayContaining(['calendar-agenda', 'drive-audit']))
      expect(typeof catalog.attach).toBe('function')
    } finally {
      await Promise.all([client.close(), server.close()])
    }
  })
})
