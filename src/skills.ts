/**
 * MCP Skills extension loader (SEP-2640 / `io.modelcontextprotocol/skills`).
 *
 * Uses `@n24q02m/hull/skills`'s `attachSkillsProvider` to validate and load the
 * packaged `skills/` directory into a shared `SkillCatalog` that attaches to
 * both `stdio` and Streamable HTTP `McpServer` instances before `connect()`.
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/server'
import { attachSkillsProvider } from '@n24q02m/hull/skills'
import { SERVER_NAME } from './constants.js'
import { getPackageVersion } from './version.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export type WorkspaceSkillCatalog = Awaited<ReturnType<typeof attachSkillsProvider>>

/**
 * Resolve the package-root `skills/` directory across all execution layouts:
 * - Vitest / source (`src/skills.ts` -> `../skills`)
 * - Bundled CLI (`bin/cli.mjs` -> `../skills`)
 * - Compiled TSC output (`build/src/skills.js` -> `../../skills`)
 */
export function resolveSkillsDir(): string {
  const candidates = [
    join(__dirname, '..', 'skills'),
    join(__dirname, '..', '..', 'skills'),
    join(__dirname, '..', '..', '..', 'skills')
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return candidates[0]!
}

/**
 * Validate `skillsDir`, load the `SkillCatalog` via `attachSkillsProvider`,
 * and attach it to `mcp` before `mcp.connect()`.
 */
export async function attachWorkspaceSkills(
  mcp: McpServer,
  skillsDir: string = resolveSkillsDir()
): Promise<WorkspaceSkillCatalog> {
  return attachSkillsProvider(mcp, skillsDir)
}

/**
 * Validate and load the package `SkillCatalog` once at transport startup so
 * per-connection factories (such as `serveStdio` and `createMcpHandler`) can
 * synchronously attach the catalog to each session `McpServer`.
 */
export async function loadWorkspaceSkillsCatalog(
  skillsDir: string = resolveSkillsDir()
): Promise<WorkspaceSkillCatalog> {
  const bootstrapServer = new McpServer({
    name: SERVER_NAME,
    version: getPackageVersion()
  })
  return attachWorkspaceSkills(bootstrapServer, skillsDir)
}
