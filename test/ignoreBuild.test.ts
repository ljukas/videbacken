import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Vercel's Ignored Build Step (vercel.json `ignoreCommand`): exit 0 skips the
// build, exit 1 builds. Each test runs the script in a throwaway git repo.
const SCRIPT = resolve(__dirname, '../scripts/ignoreBuild.sh')
const SKIP = 0
const BUILD = 1

let repo: string

const git = (...args: string[]) => {
  const out = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`)
  return out.stdout.trim()
}

const write = (path: string, content: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true })
  writeFileSync(join(repo, path), content)
}

const commit = (files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) write(path, content)
  git('add', '-A')
  git('commit', '-q', '-m', 'change')
  return git('rev-parse', 'HEAD')
}

const run = (previousSha: string | undefined) => {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH }
  if (previousSha !== undefined) env.VERCEL_GIT_PREVIOUS_SHA = previousSha
  return spawnSync('sh', [SCRIPT], { cwd: repo, env, encoding: 'utf8' })
}

let base: string

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'ignore-build-'))
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('config', 'commit.gpgsign', 'false')
  base = commit({
    'src/app.ts': 'export const a = 1\n',
    'docs/adr/0001.md': '# ADR\n',
    'docs/notes.txt': 'notes\n',
    'README.md': '# Readme\n',
    'test/browser/README.md': '# Browser tests\n',
  })
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('ignoreBuild.sh', () => {
  it('builds a branch first deployment (no previous SHA)', () => {
    commit({ 'docs/adr/0001.md': '# ADR, edited\n' })
    expect(run(undefined).status).toBe(BUILD)
    expect(run('').status).toBe(BUILD)
  })

  it('builds when the previous SHA is not in the clone', () => {
    commit({ 'docs/adr/0001.md': '# ADR, edited\n' })
    expect(run('0123456789abcdef0123456789abcdef01234567').status).toBe(BUILD)
  })

  it('skips when only files under docs/ changed', () => {
    commit({ 'docs/adr/0001.md': '# ADR, edited\n', 'docs/notes.txt': 'more notes\n' })
    const result = run(base)
    expect(result.status).toBe(SKIP)
    expect(result.stdout).toContain('skip')
  })

  it('skips when only Markdown outside docs/ changed, at the root or nested', () => {
    commit({ 'README.md': '# Readme, edited\n', 'test/browser/README.md': '# Edited\n' })
    expect(run(base).status).toBe(SKIP)
  })

  it('skips when nothing changed since the previous deployment', () => {
    expect(run(base).status).toBe(SKIP)
  })

  it('builds when code changed', () => {
    commit({ 'src/app.ts': 'export const a = 2\n' })
    const result = run(base)
    expect(result.status).toBe(BUILD)
    expect(result.stdout).toContain('src/app.ts')
  })

  it('builds when code and docs changed together', () => {
    commit({ 'src/app.ts': 'export const a = 2\n', 'docs/adr/0001.md': '# ADR, edited\n' })
    expect(run(base).status).toBe(BUILD)
  })

  it('builds when a code file moves into docs/', () => {
    renameSync(join(repo, 'src/app.ts'), join(repo, 'docs/app.ts'))
    commit({})
    expect(run(base).status).toBe(BUILD)
  })

  it('builds a code commit that follows a skipped docs commit', () => {
    commit({ 'docs/adr/0001.md': '# ADR, edited\n' })
    expect(run(base).status).toBe(SKIP)
    // The docs commit was skipped, so the previous successful deployment is still `base`.
    commit({ 'src/app.ts': 'export const a = 2\n' })
    expect(run(base).status).toBe(BUILD)
  })

  it('builds when a new non-Markdown file is added outside docs/', () => {
    commit({ 'drizzle/0030_x.sql': 'select 1;\n' })
    expect(run(base).status).toBe(BUILD)
  })
})
