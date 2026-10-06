// Captures boneyard skeletons ("bones") from the running dev app, signed in.
//
// boneyard's own headless browser has no session, so every authed route would
// capture /login. This signs a Playwright browser in through the local magic
// link (Mailpit), then runs the boneyard CLI with the session cookies.
//
// Usage (dev stack up, realistic local data, ADR-0025):
//   BETTER_AUTH_URL=http://localhost:14610 bunx vite dev --port 14610 --strictPort   # one terminal
//   bun run bones:capture                       # the default pages
//   bun run bones:capture /charging/economy     # just these paths (other pages' bones stay)
//   bun run bones:capture --force               # recapture everything (see below)
//
// The CLI skips a skeleton whose DOM hash is unchanged, even if the breakpoints
// or the CSS changed. After changing either, pass --force.
//
// Re-run after changing a skeleton-wrapped section's layout, then commit src/bones/.
// A newly captured section: switch its <SectionSkeleton name="x"> to bones={xBones},
// imported from ~/bones/x.bones.json (test/sectionSkeletonBones.test.ts enforces it).
import { spawnSync } from 'node:child_process'
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import './loadEnv'

const ORIGIN = process.env.BONES_ORIGIN ?? 'http://localhost:14610'
const MAILPIT = 'http://localhost:14602'
// Signs in as the first admin, so /charging/settings (Datakällor, the tariff card) captures too.
const DEFAULT_PATHS = [
  '/charging',
  '/charging/economy',
  '/charging/patterns',
  '/charging/settings',
  '/energy',
  '/sensors',
  '/users',
]

const email = process.env.INITIAL_ADMIN_EMAILS?.split(',')[0]?.trim()
if (!email) {
  console.error('INITIAL_ADMIN_EMAILS is unset (.env); the first address signs in.')
  process.exit(1)
}
const args = process.argv.slice(2)
const flags = args.filter((a) => a === '--force')
const given = args.filter((a) => !a.startsWith('--'))
const paths = given.length ? given : DEFAULT_PATHS

type MailpitList = { messages: { ID: string; To: { Address: string }[]; Created: string }[] }

async function latestMagicLink(since: number): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const list = (await (await fetch(`${MAILPIT}/api/v1/messages`)).json()) as MailpitList
    const msg = list.messages.find(
      (x) => x.To.some((t) => t.Address === email) && Date.parse(x.Created) >= since,
    )
    if (msg) {
      const body = (await (await fetch(`${MAILPIT}/api/v1/message/${msg.ID}`)).json()) as {
        HTML: string
        Text: string
      }
      const link = `${body.Text}\n${body.HTML}`.match(
        /https?:\/\/[^\s"<>]+magic-link\/verify[^\s"<>]+/,
      )
      if (link) return link[0].replaceAll('&amp;', '&')
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('No magic-link email arrived in Mailpit within 30 s')
}

const browser = await chromium.launch()
const context = await browser.newContext()
const page = await context.newPage()
const since = Date.now() - 1000
await page.goto(`${ORIGIN}/login`, { waitUntil: 'load' })
// Before hydration the form submits as a GET; Vite's HMR socket means
// `networkidle` never fires, so wait a fixed beat instead.
await page.waitForTimeout(4000)
await page.getByLabel('E-post').fill(email)
await page.getByRole('button', { name: 'Skicka inloggningslänk' }).click()
await page.goto(await latestMagicLink(since), { waitUntil: 'load' })
const cookies = (await context.cookies()).filter((c) => c.name.startsWith('better-auth.'))
await browser.close()
if (!cookies.some((c) => c.name.endsWith('session_token'))) {
  console.error('Signed in, but no better-auth session cookie was set.')
  process.exit(1)
}

const result = spawnSync(
  'bunx',
  [
    'boneyard-js',
    'build',
    ...paths.map((p) => `${ORIGIN}${p}`),
    '--no-scan',
    ...flags,
    ...cookies.flatMap((c) => ['--cookie', `${c.name}=${c.value}`]),
  ],
  { stdio: 'inherit' },
)
if (result.status !== 0) process.exit(result.status ?? 1)
// The CLI always writes a registry of this run's skeletons. Pages import their own
// bones (ADR-0025 §4), so nothing reads it: drop it.
for (const f of readdirSync('src/bones'))
  if (/^registry\.[jt]sx?$/.test(f)) rmSync(join('src/bones', f))
console.log('  pages import their own bones; the CLI registry was removed')
