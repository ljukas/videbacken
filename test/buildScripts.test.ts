import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// package.json's scripts carry two rules no other test sees (CLAUDE.md →
// Non-negotiables, server-latency roadmap row 9).
const { scripts } = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts: Record<string, string>
}

describe('package.json scripts', () => {
  it('seeds the first admins right after the migrations on every deploy and dev:up', () => {
    expect(scripts['vercel-build']).toMatch(/^drizzle-kit migrate && bun run db:seed && /)
    expect(scripts['dev:up']).toMatch(/bun run db:migrate && bun run db:seed$/)
    expect(scripts['db:seed']).toBe('bun scripts/seedApprovedEmails.ts')
  })

  it('checks the server entry in both builds', () => {
    expect(scripts.build).toContain('bun scripts/checkServerBundle.ts')
    expect(scripts['vercel-build']).toContain('bun scripts/checkServerBundle.ts')
  })
})

describe('scripts/seedApprovedEmails.ts', () => {
  it('exits 1 without a database, so the deploy fails', () => {
    const env = { ...process.env, INITIAL_ADMIN_EMAILS: 'first-admin@example.se' }
    delete env.DATABASE_URL
    delete env.POSTGRES_URL
    delete env.TEST_SCHEMA
    const run = spawnSync('bun', ['--no-env-file', 'scripts/seedApprovedEmails.ts'], {
      env,
      encoding: 'utf8',
    })
    expect(run.status).toBe(1)
    expect(run.stdout + run.stderr).toContain('approved-email seed failed')
  })
})
