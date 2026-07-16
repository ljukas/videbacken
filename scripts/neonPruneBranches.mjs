#!/usr/bin/env node
// Deletes the Neon branches that Neon Local created for git branches which
// no longer exist locally. Neon Local's persistent mode (compose.yaml: the
// .neon_local volume + .git/HEAD mount) makes one cloud branch per local git
// branch, and each branch costs ~32 MB of the free tier's 512 MB even when
// empty — so merged branches add up fast.
//
// Scope: only branches recorded in .neon_local/.branches are candidates.
// `main` (default/protected) and the Vercel integration's `preview/*`
// branches are never touched — the integration manages those itself.
//
// Run via `pnpm neon:prune`, with the dev stack down (`pnpm dev:down`):
// deleting the branch a live Neon Local session is proxying to breaks it.
//
// Caveat: Neon Local keys mappings by a mangled git branch name (truncated,
// sometimes cut at a `/`), so a key is treated as live if it is a prefix of
// any current local git branch. A stale key that happens to prefix a live
// branch survives until that branch is gone — fine, this is a janitor.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.loadEnvFile(resolve(root, '.env'))

const { NEON_API_KEY, NEON_PROJECT_ID } = process.env
if (!NEON_API_KEY || !NEON_PROJECT_ID) {
  console.error('[neon:prune] NEON_API_KEY and NEON_PROJECT_ID must be set in .env')
  process.exit(1)
}

const runningDb = execFileSync('docker', ['compose', 'ps', '--services', '--status', 'running'], {
  cwd: root,
  encoding: 'utf8',
})
if (runningDb.split('\n').includes('db')) {
  console.error('[neon:prune] the db service is running — `pnpm dev:down` first')
  process.exit(1)
}

const api = async (method, path) => {
  const res = await fetch(`https://console.neon.tech/api/v2${path}`, {
    method,
    headers: { Authorization: `Bearer ${NEON_API_KEY}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`)
  return res.json()
}

const mappingsFile = resolve(root, '.neon_local/.branches')
// Neon Local is paused (see compose.yaml + CLAUDE.md): it no longer writes the
// .neon_local/.branches mappings this janitor prunes, so there is nothing to do.
if (!existsSync(mappingsFile)) {
  console.log(
    '[neon:prune] Neon Local is paused — no .neon_local/.branches mappings; nothing to prune',
  )
  process.exit(0)
}
const mappings = JSON.parse(readFileSync(mappingsFile, 'utf8'))

const gitBranches = execFileSync('git', ['branch', '--format=%(refname:short)'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean)

const isLive = (key) => gitBranches.some((b) => b.startsWith(key))

const { branches } = await api('GET', `/projects/${NEON_PROJECT_ID}/branches`)
const cloudIds = new Set(branches.map((b) => b.id))
const deletable = new Set(
  branches
    .filter(
      (b) => !b.default && !b.protected && b.creation_source !== 'vercel' && b.name !== 'main',
    )
    .map((b) => b.id),
)

const kept = {}
for (const [key, { branch_id }] of Object.entries(mappings)) {
  if (!cloudIds.has(branch_id)) {
    console.log(`[neon:prune] drop stale mapping ${key} → ${branch_id} (branch already gone)`)
    continue
  }
  if (isLive(key)) {
    console.log(`[neon:prune] keep ${key} → ${branch_id} (local git branch exists)`)
    kept[key] = { branch_id }
    continue
  }
  if (!deletable.has(branch_id)) {
    console.log(`[neon:prune] keep ${key} → ${branch_id} (default/protected/vercel-managed)`)
    kept[key] = { branch_id }
    continue
  }
  await api('DELETE', `/projects/${NEON_PROJECT_ID}/branches/${branch_id}`)
  console.log(`[neon:prune] deleted ${key} → ${branch_id}`)
}

writeFileSync(mappingsFile, JSON.stringify(kept))
console.log(`[neon:prune] done — ${Object.keys(kept).length} mapping(s) kept`)
