import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '..')
const PACKAGE = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
  main: string
  files: string[]
  scripts: { build: string }
}

// The config `bun run build` hands to `tsc --build`, or tsconfig.json when it
// names none. Its output lands in build/, which package.json ships to npm.
function buildConfigPath(): string {
  const match = /\btsc\s+(?:-b|-build|--build)(?:\s+(\S+\.json))?/.exec(PACKAGE.scripts.build)
  expect(match, `no tsc --build in the build script: ${PACKAGE.scripts.build}`).not.toBeNull()
  return resolve(ROOT, match?.[1] ?? 'tsconfig.json')
}

function compiledFiles(configPath: string): string[] {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
      }
    }
  )
  if (!parsed) throw new Error(`cannot read ${configPath}`)
  return parsed.fileNames.map((file) => resolve(file))
}

describe('build config', () => {
  it('ships build/ to npm', () => {
    expect(PACKAGE.files).toContain('build/')
  })

  it('compiles no test file into build/', () => {
    const tests = compiledFiles(buildConfigPath()).filter((file) => /\.test\.ts$/.test(file))
    expect(tests).toEqual([])
  })

  it('still compiles the package entry point', () => {
    const entry = resolve(ROOT, PACKAGE.main.replace(/^build\//, '').replace(/\.js$/, '.ts'))
    expect(compiledFiles(buildConfigPath())).toContain(entry)
  })

  it('builds the Docker image with the same build script', () => {
    const dockerfile = readFileSync(resolve(ROOT, 'Dockerfile'), 'utf8')
    expect(dockerfile).toMatch(/^RUN npm run build$/m)
    expect(dockerfile).not.toMatch(/^RUN .*\btsc\b/m)
  })
})
