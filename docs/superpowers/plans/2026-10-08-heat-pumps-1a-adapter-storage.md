# Heat pumps, step 1a — Comfort Cloud adapter + storage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tested TypeScript port of the Panasonic Comfort Cloud client (`createComfortCloudClient`: Auth0 PKCE
password login, `units`, UTC `dayHours`, `monthDays`) plus the `heat_pump` / `heat_pump_reading` tables and the
service writes that store a unit's UTC day. Nothing calls any of it yet: no source literal, no facade, no sync, no UI.

**Architecture:** `src/lib/effects/comfortCloud/` is shaped like `effects/emaldo/`, minus the facade:
`constants.ts` (upstream's constants, versioned), `headers.ts` (the `x-cfc-api-key` signing), `html.ts` (Auth0 hidden
inputs), `request.ts` (the shared `fetchWithRetry` with redirects never followed), `auth.ts` (login steps 1–4 with a
`tough-cookie` jar), `client.ts` (step 5, the API calls, the app-version retry, one shared login), `parse.ts` (zod),
`errors.ts`, `fixtures.ts`. The facade, `notConfigured` and the `effects/index.ts` registration need the
`comfortCloud` literal in `CredentialSource` (`keyedAdapter<S extends CredentialSource>`), so they arrive in step 1b.
Storage follows `house_energy_reading`: a composite-key hourly table written a whole day at a time
(`replaceDay` = delete + insert in one transaction), validated in the service before the CHECKs ever fire.

**Tech Stack:** TypeScript, zod 4, ky (via `src/lib/effects/http.ts`), `tough-cookie` 6 + `htmlparser2` 12 (new),
`node:crypto` (SHA-256, PKCE, `randomInt`), Drizzle ORM + drizzle-kit, Postgres 17, Vitest (node project) with
`testing/fakeFetch` and `setupDatabase()`.

**Spec:** [`docs/superpowers/specs/2026-10-08-heat-pumps-design.md`](../specs/2026-10-08-heat-pumps-design.md)
("Source and adapter", "Schema", "Service", "Testing") · **ADR:** [`docs/adr/0027-heat-pump-energy-data.md`](../../adr/0027-heat-pump-energy-data.md)
· **Roadmap:** step 1a of [`docs/superpowers/roadmaps/2026-10-08-heat-pumps.md`](../roadmaps/2026-10-08-heat-pumps.md)
(checkpoint 1) · **Upstream:** `aio-panasonic-comfort-cloud` 2026.8.9 (MIT, Jimmy Everling):
`panasonicauthentication.py`, `panasonicrequestheader.py`, `constants.py`, `helpers.py`, `ccappversion.py`,
`apiclient/_ac.py`, `apiclient/_devices.py`, `apiclient/_urls.py`, `panasonicsession.py`.

**Branch:** `feat/heat-pumps-adapter` · **PR title:** `feat(heat-pumps): add the Comfort Cloud client and heat pump storage`

## Decisions (2026-10-08; ruled by the coordinator, the spec is amended to match — record them in the PR)

Summary: `date_bin` hour alignment; the raw guid in the history body; the UTC wall clock in `x-app-timestamp`;
`400`/`401` from the password step → `auth_failed` (suspect `user` + `password`), `403` → `forbidden`, `5xx` →
`unreachable`; the optional `{ signal, stats }` call options; the extra MFA check behind a code-less redirect; the
5-minute login block, the Auth0-origin check and `4103` without a re-login; `temperatureUnit ≠ 0` →
`unexpected_response`; a nameless unit named by its model; `setRegisteredOn` reopening the backfill when the date moves
earlier. Open: only the `hour_start` index, which the schema review (Task 6) decides. Details:

- **Cookie jar = `tough-cookie` 6.0.2** (BSD-3-Clause, last modified 2026-07-07, one dependency `tldts`, ships its own
  types; `npm view`). Not in `package.json` (`cookie`, `cookie-es`, `set-cookie-parser` sit in `node_modules` only as
  transitive deps — never import those). The Auth0 steps need RFC 6265 matching: the `_csrf` cookie is path-scoped,
  every cookie is `Secure`, `auth0` is overwritten by the callback. Hand-rolling that is the jar's whole job, so
  CLAUDE.md's rule picks the library. API used (verified in a scratch install, Node 23): `new CookieJar()`,
  `await jar.setCookie(setCookieHeader, url, { ignoreError: true })`, `await jar.getCookieString(url)`,
  `await jar.getCookies(url)` (`.key`, `.value`). With `_csrf=C; Path=/usernamepassword/login` it sent `_csrf=C;
  auth0=A; did=D` to `/usernamepassword/login`, `auth0=A; did=D` to `/login/callback`, nothing to another host.
  Rejected: `fetch-cookie` 3.2.0 (Unlicense, last modified 2025-12, wraps `fetch` around the jar we'd still need);
  `set-cookie-parser` alone (parses, doesn't match paths/expiry).
- **HTML = `htmlparser2` 12.0.0** (MIT, last modified 2026-07-17, ESM, Node ≥ 20.19, own types; the parser cheerio
  uses). The streaming `Parser` with `onopentag(name, attribs)` (Context7 `/fb55/htmlparser2`) decodes entities and
  lowercases tag/attribute names. Verified in a scratch install: `<INPUT TYPE="hidden" NAME="wctx"
  VALUE='{"strategy":"auth0"}'>` and `value="eyJ&amp;x&quot;"` came back as `wctx: '{"strategy":"auth0"}'`,
  `wresult: 'eyJ&x"'`; a `type="text"` input was ignored. Rejected: a regex (attribute order, quoting, and `wctx` is
  entity-encoded JSON inside an attribute); `node-html-parser` 9.0.4 (works, but builds a DOM + css-select for what
  is one open-tag callback). Server-only code: bundle size doesn't matter.
- **The Guardian MFA page is detected by the substring `__g_config`**, as upstream starts. Upstream then needs three
  keys before it treats the page as MFA; we treat any Guardian config as "MFA demanded", since we can't answer it.
- **HTTP = `fetchWithRetry`** (10 s, 502/503/504 retried once, as Emaldo) with `redirect: 'manual'` on every
  request. Verified against a local server through the real `src/lib/effects/http.ts` on Node 23 and Bun: ky 2.1.0
  never touches `redirect`; a 302 is neither ok nor a retry status, so it comes back **unread** with `Location` and
  `headers.getSetCookie()` intact; a 2xx comes back with its body read and its `Set-Cookie` intact
  (`new Response(buffer, res)` copies all headers). Node's `Request` keeps a `Cookie` header. So the jar is filled
  from `res.headers.getSetCookie()` after each step and sent as `cookie` on the next. A 302 body is `discard`ed.
- **Locations are followed only on `https://authglb.digital.panasonic.com`.** Upstream concatenates
  `f"{BASE_PATH_AUTH}/{location}"`; we resolve with `new URL(location, AUTH_BASE)` and refuse any other origin
  (`unexpected_response`), so a hostile redirect can't send the jar or the password elsewhere.
- **`x-app-timestamp` is the UTC wall clock** (`2026-10-08 12:34:56`). Upstream sends the host's local wall clock and
  signs that string read as UTC; on Vercel (TZ=UTC) that is exactly UTC. Sending UTC everywhere keeps local runs and
  prod identical. The key is computed from the same string, so header and key always agree.
- **`x-cfc-api-key` pinned against upstream.** For timestamp `2026-10-08 12:34:56` and token
  `test-access-token-not-real`, upstream's `PanasonicRequestHeader._get_api_key` (run from the 2026.8.9 package) and
  the hand computation below both give `f35f52721cfcd67f30ebc9e6f4dbe899423097c34ab154685f4a03dbc0826c3fa3d`
  (epoch ms `1791462896000`):

  ```bash
  python3 -I -c "import hashlib,datetime;ts='2026-10-08 12:34:56';tok='test-access-token-not-real';ms=str(int(datetime.datetime.strptime(ts,'%Y-%m-%d %H:%M:%S').replace(tzinfo=datetime.timezone.utc).timestamp()*1000));h=hashlib.sha256(b''.join([b'Comfort Cloud',b'521325fb2dd486bf4831b47644317fca',ms.encode(),b'Bearer ',tok.encode()])).hexdigest();print(ms, h[:9]+'cfc'+h[9:])"
  # → 1791462896000 f35f52721cfcd67f30ebc9e6f4dbe899423097c34ab154685f4a03dbc0826c3fa3d
  ```

  PKCE likewise: verifier `0123456789abcdefghijABCDEFGHIJklmnopqrstUVW` → challenge
  `uXi7Kb2X0AcU627-0OIOlA_yXr1Ii5m7cRDeVLUbxxA`:

  ```bash
  python3 -I -c "import hashlib,base64;v='0123456789abcdefghijABCDEFGHIJklmnopqrstUVW';print(base64.urlsafe_b64encode(hashlib.sha256(v.encode()).digest()).split(b'=')[0].decode())"
  ```
- **The history body sends the raw guid.** Upstream's `/`→`f` replacement lives in `_prepare_device_guid`, used only
  for URL path segments (status calls); `history()` posts `device_guid` unchanged, and that is what the probe ran.
- **Login block.** A login refused as `auth_failed` (rejected password, demanded MFA, a refused fresh token) blocks
  new login attempts for 5 minutes, as Emaldo does: repeated "Synka nu" clicks must not walk the account into Auth0's
  brute-force lockout (which also emails the owner).
- **CHECK alignment uses `date_bin`, not `date_trunc`.** `date_trunc('hour', timestamptz)` depends on the session's
  `TimeZone` (wrong for half-hour zones) and is only `STABLE`; `house_energy_reading_bucket_aligned_check` already uses
  `date_bin('5 minutes', …, timestamptz '2000-01-01 00:00:00+00')` for this reason. Same rule, one hour.
- **Celsius only.** Every history answer carries `temperatureUnit`; anything but `0` (Celsius) fails the call
  `unexpected_response` with a message naming the account's temperature-unit setting, so °F never lands in a °C column.
- **A nameless unit is named by its model** (`deviceName` empty → `deviceModuleNumber`).
- **`setRegisteredOn` reopens the backfill.** When the new `registered_on` is earlier than the stored one, the same
  update clears `history_complete_at`, so 1b's backfill (which walks units without `history_complete_at`) resumes
  down to the new date. A later or equal date, or a first-time set, leaves `history_complete_at` alone.
- **Index on `hour_start` alone: open, the schema review decides (Task 6).** The plan adds none: the PK
  (`heat_pump_id`, `hour_start`) serves every 1a/1b query, and steps 2–3 read a time range across two or three
  units at ≈ 17.5k rows a year, where a sequential scan or the PK is milliseconds. The review gets the real queries.
- **Trivial UTC helpers are hand-written** (`src/lib/time/utc.ts`, ≈ 25 lines): a UTC day needs only `Date.UTC`;
  `stockholm.ts` stays the one module that names a zone.

## Contract notes (cross-step names from the planners' brief)

1. **Additive:** `units`, `dayHours`, `monthDays` take an optional trailing `o?: ComfortCloudCallOpts`
   (`{ signal?, stats? }`), and the module exports `ComfortCloudCallStats` + `newCallStats()`, as Emaldo's
   `CallOpts` / `EmaldoCallStats`. Step 1b's run line needs `fetchMs` / `requests` / `retries` / `logins`; calls
   written to the brief's signatures still compile.
2. **Split:** 1a exports `createComfortCloudClient`, the types, `ComfortCloudError`, `newCallStats`. The
   `comfortCloud` facade, `adapters/notConfigured.ts`, `selectComfortCloudAdapter` and the `effects/index.ts` line
   are 1b's (they need `comfortCloud` in `CredentialSource`). `IntegrationError`'s `suspectFields` is typed
   `readonly CredentialFieldName[]`, which already contains `'user'` and `'password'` (Zaptec/Emaldo), so
   `ComfortCloudError` can name them in 1a; 1b may narrow the type to `CredentialField<'comfortCloud'>`.
3. **`HeatPumpDomainError` codes are `SCREAMING_SNAKE`** (`'INVALID_READING' | 'UNKNOWN_HEAT_PUMP'`), the repo's
   service convention (`HouseEnergyDomainError`, `UserDomainError`, …), per the coordinator's correction to the brief
   (the spec's prose writes them lowercase; step 4a's codes follow the same convention). The effect's
   `IntegrationErrorCode` values (`auth_failed`, `unexpected_response`, …) stay lowercase as in `integrationHealth.ts`.
4. `replaceDay`'s `hours` parameter is typed `readonly HeatPumpHourInput[]` (accepts every array the brief's type
   does). `ComfortCloudHour` and `HeatPumpHourInput` are structurally identical, so 1b passes `rows` straight through.
5. An invalid `utcDay` / `utcMonth` / guid is a caller bug: `RangeError`, no request (as Emaldo's offset), not a
   domain error. `upsertUnits` returns the rows in input order (deduplicated by guid); `listUnits` orders by name.

## Global Constraints

- Read-only (ADR-0027 decision 1). The client calls exactly: Auth0 `GET /authorize`, `GET /login`,
  `POST /usernamepassword/login`, `POST /login/callback`, `GET /authorize/resume`, `POST /oauth/token` (and one
  challenge page on the Auth0 host when the final redirect has no code); `POST accsmart.panasonic.com/auth/v2/login`,
  `GET /device/group`, `POST /deviceHistoryData`; `GET play.google.com/store/apps/details` on `401` + `4106` only.
  Never the status endpoint, never a control call.
- Effects isolated (ADR-0001). The client **never logs**: no `logger` or `console` import anywhere in
  `src/lib/effects/comfortCloud/`; it fills the caller's `stats` and throws `ComfortCloudError`.
- 1a adds **no** source literal, facade, `notConfigured`, `effects/index.ts` line, env var, cron, procedure or UI.
- Error messages and causes never carry: the user, the password, any token (access, refresh, id, Guardian, MFA), the
  authorization code, `_csrf`, `wresult`, the api key, the client id, a unit guid, raw HTML or JSON, or a reading.
  zod failures name paths only (`summarizeIssuePaths`); network failures keep only `networkCause` (`{ name, code }`).
- Error mapping (exact): rejected password (`400` / `401` from `/usernamepassword/login`) → `auth_failed`,
  `suspectFields: ['user', 'password']`; `mfa_token` input or `__g_config` → `auth_failed` (message names 2FA, no
  suspect fields); `401` without `4106` twice (before and after one fresh login) → `auth_failed`; `403` →
  `forbidden`; `429` → `rate_limited`; `5xx` (after the one retry for 502/503/504), network failure, timeout, caller
  abort → `unreachable`; failed Play Store lookup, still `4106` after it, `4103` (terms), non-JSON, zod failure, a
  row outside the asked day/month, a repeated row, a missing or impossible `deviceRegisterTime`, a missing
  `temperatureUnit` or one other than `0` (Celsius), a missing `_csrf` /
  `state` / callback form / `code`, a redirect off the Auth0 host, any other status → `unexpected_response`.
- Wire (exact): every history call `osTimezone: '+00:00'`, `dataMode` 0 (day) or 2 (month), `date: 'YYYYMMDD'` (the
  month's first day for mode 2), the raw `deviceGuid`. API headers: `accept: application/json; charset=utf-8`,
  `content-type: application/json`, `user-agent: G-RAC`, `x-app-name: Comfort Cloud`, `x-app-type: 1`,
  `x-app-version` (pinned `4.4.0`, replaced in memory after a `4106` lookup), `x-app-timestamp` (UTC
  `YYYY-MM-DD HH:mm:ss`), `x-cfc-api-key`, `x-user-authorization-v2: Bearer <token>`, `x-client-id` (all but
  `/auth/v2/login`).
- Login: a fresh cookie jar per login; redirects never auto-followed; Locations followed only on the Auth0 origin;
  tokens only in the client's memory; a new login once the token is ≥ 23 h old or a call answers `401` without
  `4106`; the refresh token is never used; concurrent callers share one in-flight login.
- `-255` (`NO_VALUE`): a row with `consumption < 0` is dropped; any other field equal to `-255` becomes `null`;
  every other value passes through and the service range-checks it (a bad row fails the day: `INVALID_READING`).
- Schema: `heat_pump` and `heat_pump_reading` exactly as the spec's tables, `.enableRLS()`, every timestamp
  `timestamptz`, `registered_on` `date`, CHECKs `0 ≤ energy_kwh < 5`, shares `0…1`, temperatures `−60…60`, hour
  alignment via `date_bin`; FK `ON DELETE CASCADE`; migration `--name=heat_pump`. Schema-design review +
  `migration-guard` before the service builds on it (Non-negotiable).
- Fixtures are **synthetic** (public repo): fake guids `CS-HZ25ZKE+0000000001` / `…0002`, made-up kWh and
  temperatures, fake tokens. Names "Matsal" / "Övervåning" are fine. The checkpoint script and its outputs live only
  in the session scratchpad, never in the repo.
- New dependencies: `tough-cookie@^6.0.2`, `htmlparser2@^12.0.0`, nothing else.
- No user-facing copy in this step (no i18n keys).
- Biome style (single quotes, no semicolons, width 100); `bun run check` before each commit; `git add <paths>`, never
  `-A`. Conventional Commits ≤ 72 chars, one hat per commit, every message ends with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **A wrong password, then "Synka nu" clicked repeatedly (or every cron run retried by hand)**: one Auth0 attempt,
   then the same `auth_failed` for 5 minutes with no request, so Auth0's brute-force lockout (and its email to the
   owner) is never tripped. → Task 4 ("a refused login blocks new logins for five minutes").
2. **Today's still-filling day, and an hour where the unit was offline but the meter wasn't**: rows with
   `consumption -255` are dropped; a row with kWh but `-255` temperatures or shares keeps the kWh and stores `null`
   for those fields (never `-255`, never a dropped kWh). → Task 2 ("future hours are dropped…", "a -255 temperature
   with a real kWh…").
3. **A response whose rows aren't the asked day** (a server-side `osTimezone` change, a month answer with another
   month's day, a repeated hour): fail the call `unexpected_response`, never store hours under the wrong instants.
   → Task 2 ("a row of another day…", "a repeated hour…", month equivalents).
4. **Panasonic publishes a new app version mid-run**, including on the `/auth/v2/login` step: one Play Store lookup,
   one retry, the new version kept for the client's life; a failed lookup or a second `4106` is
   `unexpected_response`, never a loop. → Task 4 ("401 + 4106…" tests).
5. **Secrets echoed by the remote**: Auth0's error description quoting the email, a network error whose message
   quotes the URL or body, MFA/Guardian tokens in the HTML, the api key derived from the token: none reach a
   message, cause or stack. → Tasks 3 and 4 (`secretsIn(err)` on every failure test).

---

## File structure

| File | Responsibility |
|---|---|
| `package.json`, `bun.lock` (modify) | `tough-cookie`, `htmlparser2` |
| `src/lib/time/utc.ts` (+ `utc.test.ts`) (create) | `isUtcDay`, `isUtcMonth`, `utcDayBounds`, `utcDayOf` (client-safe) |
| `src/lib/effects/comfortCloud/constants.ts` (create) | Upstream constants (client id, `auth0Client`, redirect URI, app key, user agents), pinned app version, data modes |
| `src/lib/effects/comfortCloud/headers.ts` (+ `headers.test.ts`) (create) | `appTimestamp`, `cfcApiKey`, `apiHeaders` |
| `src/lib/effects/comfortCloud/html.ts` (+ `html.test.ts`) (create) | `hiddenInputs`, `hasGuardianConfig` |
| `src/lib/effects/comfortCloud/comfortCloud.ts` (create) | Public types, `ComfortCloudCallStats`, `newCallStats` (the facade joins in 1b) |
| `src/lib/effects/comfortCloud/errors.ts` (create) | `ComfortCloudError`, `ComfortCloudOp`, `ComfortCloudCredentialField` |
| `src/lib/effects/comfortCloud/parse.ts` (+ `parse.test.ts`) (create) | zod: token, `clientId`, units, day and month history |
| `src/lib/effects/comfortCloud/fixtures.ts` (create) | Synthetic responses shaped like the probe, Auth0 routes, `secretsIn` |
| `src/lib/effects/comfortCloud/request.ts` (create) | `send` (fetchWithRetry, `redirect: 'manual'`), `statusError`, `errorForStatus` |
| `src/lib/effects/comfortCloud/auth.ts` (+ `auth.test.ts`) (create) | `passwordLogin` (steps 1–4), `pkceChallenge`, `randomString` |
| `src/lib/effects/comfortCloud/client.ts` (+ `comfortCloud.test.ts`) (create) | `createComfortCloudClient` |
| `src/lib/effects/comfortCloud/index.ts` (create) | Barrel |
| `src/lib/db/schema/heatPump.ts` (create), `schema/index.ts` (modify) | `heatPump`, `heatPumpReading`, range constants |
| `src/lib/db/heatPumpSchema.test.ts` (create) | Keys, CHECKs, FK cascade |
| `drizzle/0022_heat_pump.sql`, `drizzle/meta/*` (generate) | Migration |
| `src/lib/db/pgError.ts` (+ test), `src/lib/services/houseEnergy/houseEnergy.ts` (modify) | `pgErrorSummary` shared (refactor commit) |
| `src/lib/services/heatPump/{heatPump.ts,errors.ts,index.ts,heatPump.test.ts}` (create) | The writes |
| `CLAUDE.md` (modify) | Code map lines |
| `docs/superpowers/roadmaps/2026-10-08-heat-pumps.md` (modify) | Row 1a → PR open |

---

### Task 0: Check `main` still matches this plan; worktree

**Files:** none (only this plan, if it needs fixing) · **Reviewers:** none (a read-only gate)

- [ ] **Step 1: Worktree from up-to-date main**

```bash
cd /Users/lukas/prog/videbacken
git fetch origin
git worktree add .claude/worktrees/heat-pumps-1a -b feat/heat-pumps-adapter origin/main
cd .claude/worktrees/heat-pumps-1a
cp ../../../.env .env
# .env.local holds secrets: copy it, never print it. It must not carry a prod DATABASE_URL (CLAUDE.md gotcha):
[ -f ../../../.env.local ] && cp ../../../.env.local .env.local && grep -c '^DATABASE_URL' .env.local
bun install
```
Expected: the `grep -c` prints `0`. Anything else: delete those lines from `.env.local` before running anything.

- [ ] **Step 2: The design docs are on main, row 1a is the first step**

```bash
git ls-tree --name-only origin/main docs/adr/0027-heat-pump-energy-data.md \
  docs/superpowers/specs/2026-10-08-heat-pumps-design.md \
  docs/superpowers/roadmaps/2026-10-08-heat-pumps.md \
  docs/superpowers/plans/2026-10-08-heat-pumps-1a-adapter-storage.md
grep -n "^| 1a |" docs/superpowers/roadmaps/2026-10-08-heat-pumps.md
```
Expected: four paths; row 1a reads `not started`. If the docs aren't on main, **stop** and ask the owner to merge the
docs PR. Then set row 1a to `in progress` (committed with Task 8's roadmap edit).

- [ ] **Step 3: Every seam this plan consumes**

```bash
# Nothing heat-pump exists yet; the source lists are untouched (1b adds comfortCloud)
ls src/lib/effects/comfortCloud src/lib/services/heatPump src/lib/time/utc.ts 2>&1 | grep -c "No such file"   # → 3
grep -rn "comfortCloud\|heat_pump\|heatPump\|tough-cookie\|htmlparser2" src drizzle package.json | head -3     # → no output
grep -n "INTEGRATION_SOURCES = \[" src/lib/integrationHealth.ts       # → zaptec, elpris, skoda, emaldo
grep -n "CREDENTIAL_SOURCES = \[" src/lib/integrationCredentials.ts   # → zaptec, skoda, emaldo, gridTariff
# 'user' and 'password' are already credential field names (Emaldo), so ComfortCloudError can name them
grep -n "user\|password" src/lib/integrationCredentials.ts | head -6
grep -n "suspectFields?: readonly CredentialFieldName\[\]" src/lib/effects/integrationError.ts
# keyedAdapter needs a CredentialSource (why the facade waits for 1b)
grep -n "export function keyedAdapter<S extends CredentialSource" src/lib/effects/keyedAdapter.ts
# The shared HTTP policy
grep -n "export async function fetchWithRetry\|retryLimit?: number\|methods: \['get', 'post'\]\|export async function discard\|export function networkCause\|stats: { requests: number; retries: number }" src/lib/effects/http.ts
# fakeFetch routes by "<METHOD> <pathname>" (host ignored); exposes callsTo and jsonResponse
grep -n "new URL(req.url).pathname\|callsTo\|export function jsonResponse\|export type FakeRoute" src/lib/effects/testing/fakeFetch.ts
grep -n "export function issuePath\|export function summarizeIssuePaths" src/lib/issuePaths.ts
grep -n "'auth_failed'\|'forbidden'\|'rate_limited'\|'unreachable'\|'unexpected_response'" src/lib/integrationHealth.ts
# Emaldo idioms this plan copies (fake timers with ky, the error class)
grep -n "setTimerTickMode('nextTimerAsync')\|spyOn(Math, 'random')" src/lib/effects/emaldo/emaldo.test.ts
grep -n "override readonly name = 'EmaldoError'" src/lib/effects/emaldo/errors.ts
# Storage idioms: setupDatabase, constraint helper, the day-replace pattern, the private pg summary to share
grep -n "export function setupDatabase" test/setup.ts
grep -n "export async function expectConstraintViolation" test/expectConstraintViolation.ts
grep -n "function pgSummary\|throw new Error(\`Storing house energy readings failed" src/lib/services/houseEnergy/houseEnergy.ts
grep -n "export function isUniqueViolation" src/lib/db/pgError.ts
grep -n "date_bin('5 minutes'" src/lib/db/schema/houseEnergy.ts
tail -1 src/lib/db/schema/index.ts                     # → export * from './vehicleState'
ls drizzle/*.sql | tail -1                             # → drizzle/0021_house_energy_month_view.sql
# The library decisions still hold
npm view tough-cookie version license time.modified    # → 6.0.2 BSD-3-Clause (newer: read its changelog for setCookie/getCookieString)
npm view htmlparser2 version license time.modified     # → 12.0.0 MIT (newer: check Parser/onopentag)
```
Expected: each grep prints at least one line (except the "→ no output" one). If the newest migration is past 0021,
Task 5's file is the next number: adjust the names in Tasks 5, 6 and 8. If `fetchWithRetry`'s policy shape, `fakeFetch`
routing or `IntegrationError`'s constructor changed, fix this plan's code first.

- [ ] **Step 4: Baseline is green**

```bash
bun run db:up && bun run db:migrate
bunx vitest run src/lib/effects/emaldo src/lib/services/houseEnergy/houseEnergy.test.ts src/lib/db/pgError.test.ts
```
Expected: PASS. (Never run vitest while another session's vitest uses the local DB: per-worker schema names collide.)

---

### Task 1: Dependencies and the pure building blocks (UTC days, constants, signing, hidden inputs)

**Reviewers:** `code-reviewer` + `test-completeness` (effect adapter layer), both told to assume the task is wrong and
not up to spec; `code-reviewer` additionally checks the constants and the key algorithm line by line against
upstream's `constants.py` and `panasonicrequestheader.py` (paths in the plan header).

**Files:**
- Modify: `package.json`, `bun.lock`
- Create: `src/lib/time/utc.ts`, `src/lib/time/utc.test.ts`
- Create: `src/lib/effects/comfortCloud/constants.ts`
- Create: `src/lib/effects/comfortCloud/headers.ts`, `headers.test.ts`
- Create: `src/lib/effects/comfortCloud/html.ts`, `html.test.ts`

**Interfaces:**
- Produces:
  - `isUtcDay(day: string): boolean`, `isUtcMonth(month: string): boolean`,
    `utcDayBounds(day: string): { startMs: number; endMs: number }` (RangeError on a bad day),
    `utcDayOf(ms: number): string` — `src/lib/time/utc.ts`
  - constants: `AUTH_BASE`, `ACC_BASE`, `APP_CLIENT_ID`, `AUTH0_CLIENT`, `REDIRECT_URI`, `AUDIENCE`, `SCOPE`,
    `AUTH0_TENANT`, `AUTH0_CONNECTION`, `AUTH_API_USER_AGENT`, `AUTH_BROWSER_USER_AGENT`, `APP_NAME`, `APP_KEY`,
    `API_USER_AGENT`, `PINNED_APP_VERSION`, `PLAY_STORE_URL`, `PLAY_STORE_VERSION_RE`, `DATA_MODE_DAY`,
    `DATA_MODE_MONTH`, `OS_TIMEZONE`, `UPSTREAM_VERSION`
  - `appTimestamp(now: Date): string`, `cfcApiKey(timestamp: string, token: string): string`,
    `apiHeaders(o: { now: Date; token: string; appVersion: string; clientId?: string }): Record<string, string>`
  - `hiddenInputs(html: string): Map<string, string>`, `hasGuardianConfig(html: string): boolean`

- [ ] **Step 1: Add the two libraries**

```bash
bun add tough-cookie@^6.0.2 htmlparser2@^12.0.0
grep -n '"tough-cookie"\|"htmlparser2"' package.json
ls node_modules/tough-cookie/dist/index.d.ts node_modules/htmlparser2/dist/index.d.ts
```
Expected: both in `dependencies`; both ship their own types (no `@types/*`).

- [ ] **Step 2: Write the failing tests**

`src/lib/time/utc.test.ts`:
```ts
import { expect, test } from 'vitest'
import { isUtcDay, isUtcMonth, utcDayBounds, utcDayOf } from './utc'

test('isUtcDay accepts real YYYY-MM-DD days in 1970–2999 only', () => {
  expect(isUtcDay('2026-10-08')).toBe(true)
  expect(isUtcDay('2028-02-29')).toBe(true)
  for (const bad of ['2026-02-29', '2026-13-01', '2026-1-01', '20261008', '1969-12-31', '3000-01-01', ''])
    expect(isUtcDay(bad), bad).toBe(false)
})

test('isUtcMonth accepts real YYYY-MM months only', () => {
  expect(isUtcMonth('2026-10')).toBe(true)
  for (const bad of ['2026-13', '2026-00', '2026-1', '202610', '2026-10-01']) expect(isUtcMonth(bad), bad).toBe(false)
})

test('a UTC day is always 24 h, DST days included', () => {
  expect(utcDayBounds('2026-03-29')).toEqual({
    startMs: Date.UTC(2026, 2, 29),
    endMs: Date.UTC(2026, 2, 30),
  })
  expect(utcDayBounds('2025-10-26').endMs - utcDayBounds('2025-10-26').startMs).toBe(86_400_000)
  expect(() => utcDayBounds('2026-02-30')).toThrow(RangeError)
})

test('utcDayOf is the UTC calendar day of an instant', () => {
  expect(utcDayOf(Date.UTC(2026, 9, 8, 23, 59, 59, 999))).toBe('2026-10-08')
  expect(utcDayOf(Date.UTC(2026, 9, 9))).toBe('2026-10-09')
})
```

`src/lib/effects/comfortCloud/headers.test.ts`:
```ts
import { expect, test } from 'vitest'
import { PINNED_APP_VERSION } from './constants'
import { apiHeaders, appTimestamp, cfcApiKey } from './headers'

// Pinned against upstream aio-panasonic-comfort-cloud 2026.8.9 `PanasonicRequestHeader._get_api_key`.
// Reproduce by hand (see the plan's "Decisions"):
//   python3 -I -c "import hashlib,datetime;ts='2026-10-08 12:34:56';tok='test-access-token-not-real';ms=str(int(datetime.datetime.strptime(ts,'%Y-%m-%d %H:%M:%S').replace(tzinfo=datetime.timezone.utc).timestamp()*1000));h=hashlib.sha256(b''.join([b'Comfort Cloud',b'521325fb2dd486bf4831b47644317fca',ms.encode(),b'Bearer ',tok.encode()])).hexdigest();print(ms, h[:9]+'cfc'+h[9:])"
test('cfcApiKey matches upstream for a fixed timestamp and token', () => {
  expect(cfcApiKey('2026-10-08 12:34:56', 'test-access-token-not-real')).toBe(
    'f35f52721cfcd67f30ebc9e6f4dbe899423097c34ab154685f4a03dbc0826c3fa3d',
  )
})

test('cfcApiKey refuses anything but YYYY-MM-DD HH:mm:ss', () => {
  for (const bad of ['2026-10-08T12:34:56', '2026-10-08 12:34', '2026-10-08 12:34:56Z', ''])
    expect(() => cfcApiKey(bad, 't'), bad).toThrow(RangeError)
})

test('the app timestamp is the UTC wall clock to the second', () => {
  expect(appTimestamp(new Date('2026-10-08T12:34:56.789Z'))).toBe('2026-10-08 12:34:56')
})

test('apiHeaders carries every header upstream sends, the key signed over the same timestamp', () => {
  const now = new Date('2026-10-08T12:34:56.789Z')
  const headers = apiHeaders({ now, token: 'test-access-token-not-real', appVersion: PINNED_APP_VERSION, clientId: 'cid' })
  expect(headers).toEqual({
    accept: 'application/json; charset=utf-8',
    'content-type': 'application/json',
    'user-agent': 'G-RAC',
    'x-app-name': 'Comfort Cloud',
    'x-app-timestamp': '2026-10-08 12:34:56',
    'x-app-type': '1',
    'x-app-version': '4.4.0',
    'x-cfc-api-key': 'f35f52721cfcd67f30ebc9e6f4dbe899423097c34ab154685f4a03dbc0826c3fa3d',
    'x-user-authorization-v2': 'Bearer test-access-token-not-real',
    'x-client-id': 'cid',
  })
  expect(apiHeaders({ now, token: 't', appVersion: '4.4.0' })).not.toHaveProperty('x-client-id')
})
```

`src/lib/effects/comfortCloud/html.test.ts`:
```ts
import { expect, test } from 'vitest'
import { hasGuardianConfig, hiddenInputs } from './html'

test('reads hidden inputs with entities decoded, whatever the case or quoting', () => {
  const inputs = hiddenInputs(`<form action="https://authglb.digital.panasonic.com/login/callback">
    <input type="hidden" name="wa" value="wsignin1.0">
    <input type="hidden" name="wresult" value="abc&amp;def&quot;">
    <INPUT TYPE="Hidden" NAME="wctx" VALUE='{"strategy":"auth0"}'>
    <input type="hidden" name="wctx2" value="{&#34;a&#34;:1}">
    <input type="hidden" name="empty">
    <input type="text" name="username" value="not-hidden">
    <input type="hidden" value="no-name">
  </form>`)
  expect(Object.fromEntries(inputs)).toEqual({
    wa: 'wsignin1.0',
    wresult: 'abc&def"',
    wctx: '{"strategy":"auth0"}',
    wctx2: '{"a":1}',
    empty: '',
  })
})

test('a remote name like __proto__ is just a key', () => {
  const inputs = hiddenInputs('<input type="hidden" name="__proto__" value="x">')
  expect(inputs.get('__proto__')).toBe('x')
  expect(({} as Record<string, unknown>).x).toBeUndefined()
})

test('no inputs in a page without a form', () => {
  expect(hiddenInputs('<html><body>Hi</body></html>').size).toBe(0)
})

test('spots the Auth0 Guardian MFA widget config', () => {
  expect(hasGuardianConfig('<script>window.__g_config = { requestToken: "x" }</script>')).toBe(true)
  expect(hasGuardianConfig('<html><form></form></html>')).toBe(false)
})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `bunx vitest run src/lib/time/utc.test.ts src/lib/effects/comfortCloud/headers.test.ts src/lib/effects/comfortCloud/html.test.ts`
Expected: FAIL — `Failed to resolve import "./utc"` / `"./constants"` / `"./html"`.

- [ ] **Step 4: Implement**

`src/lib/time/utc.ts`:
```ts
// Client-safe UTC calendar helpers for sources that report whole UTC days (Comfort Cloud,
// ADR-0027). Deliberately tiny: a UTC day needs only Date.UTC. Stockholm days live in
// stockholm.ts, the one module that names that zone.
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const MONTH_RE = /^\d{4}-\d{2}$/
const DAY_MS = 86_400_000

/** Midnight UTC of `day` in ms, or null unless it is a real 'YYYY-MM-DD' day in 1970–2999. */
function parseUtcDay(day: string): number | null {
  const match = DAY_RE.exec(day)
  if (!match) return null
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (y < 1970 || y > 2999) return null
  const ms = Date.UTC(y, m - 1, d)
  const date = new Date(ms)
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? ms : null
}

/** Whether `day` is a real 'YYYY-MM-DD' day in 1970–2999. */
export function isUtcDay(day: string): boolean {
  return parseUtcDay(day) !== null
}

/** Whether `month` is a real 'YYYY-MM' month in 1970–2999. */
export function isUtcMonth(month: string): boolean {
  return MONTH_RE.test(month) && isUtcDay(`${month}-01`)
}

/** `[startMs, endMs)` of UTC `day`: always 24 h. Throws RangeError for anything but a real day. */
export function utcDayBounds(day: string): { startMs: number; endMs: number } {
  const startMs = parseUtcDay(day)
  if (startMs === null) throw new RangeError(`Not a YYYY-MM-DD day: ${day}`)
  return { startMs, endMs: startMs + DAY_MS }
}

/** The UTC 'YYYY-MM-DD' an instant falls in. */
export function utcDayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}
```

`src/lib/effects/comfortCloud/constants.ts`:
```ts
// Copied from aio-panasonic-comfort-cloud 2026.8.9 (MIT, © Jimmy Everling): constants.py,
// panasonicrequestheader.py, panasonicauthentication.py, ccappversion.py. They are the Comfort
// Cloud Android app's own values. When Panasonic changes the login (the source fails as
// auth_failed / unexpected_response), diff upstream's newest release against these and update
// them together, bumping UPSTREAM_VERSION.
export const UPSTREAM_VERSION = '2026.8.9'

export const AUTH_BASE = 'https://authglb.digital.panasonic.com'
export const ACC_BASE = 'https://accsmart.panasonic.com'

export const APP_CLIENT_ID = 'Xmy6xIYIitMxngjB2rHvlm6HSDNnaMJx'
export const AUTH0_CLIENT =
  'eyJuYW1lIjoiQXV0aDAuQW5kcm9pZCIsImVudiI6eyJhbmRyb2lkIjoiMzAifSwidmVyc2lvbiI6IjIuOS4zIn0='
export const REDIRECT_URI =
  'panasonic-iot-cfc://authglb.digital.panasonic.com/android/com.panasonic.ACCsmart/callback'
export const AUDIENCE = `https://digital.panasonic.com/${APP_CLIENT_ID}/api/v1/`
export const SCOPE = 'openid offline_access comfortcloud.control a2w.control'
export const AUTH0_TENANT = 'pdpauthglb-a1'
export const AUTH0_CONNECTION = 'PanasonicID-Authentication'
export const AUTH_API_USER_AGENT = 'okhttp/4.10.0'
export const AUTH_BROWSER_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Mobile Safari/537.36'

export const APP_NAME = 'Comfort Cloud'
/** The key baked into the app that `x-cfc-api-key` hashes (panasonicrequestheader.py). */
export const APP_KEY = '521325fb2dd486bf4831b47644317fca'
export const API_USER_AGENT = 'G-RAC'
/** The app version at the 2026-10-08 probe. A 401 + 4106 swaps it in memory for the Play Store's. */
export const PINNED_APP_VERSION = '4.4.0'
export const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.panasonic.ACCsmart'
/** Upstream's `_update_playstore` pattern. */
export const PLAY_STORE_VERSION_RE = /\["(\d+\.\d+\.\d+)"\]/

/** `deviceHistoryData` modes (constants.DataMode): 24 hourly rows, or one row per day of the month. */
export const DATA_MODE_DAY = 0
export const DATA_MODE_MONTH = 2
/** Every history request: rows are then exact UTC hours, DST-proof (spec, live probe). */
export const OS_TIMEZONE = '+00:00'
```

`src/lib/effects/comfortCloud/headers.ts`:
```ts
import { createHash } from 'node:crypto'
import { API_USER_AGENT, APP_KEY, APP_NAME } from './constants'

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

/**
 * `x-app-timestamp`: `YYYY-MM-DD HH:mm:ss`. Upstream sends the host's wall clock; on Vercel that
 * is UTC, so we send UTC everywhere and local runs match prod.
 */
export function appTimestamp(now: Date): string {
  return now.toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * Upstream's `_get_api_key`: SHA-256 hex of "Comfort Cloud" + the app key + the timestamp read as a
 * UTC instant in epoch ms + "Bearer " + the token, with `cfc` inserted after the 9th character.
 * The result is derived from the token: never log it or put it in an error.
 */
export function cfcApiKey(timestamp: string, token: string): string {
  if (!TIMESTAMP_RE.test(timestamp)) throw new RangeError('Not a YYYY-MM-DD HH:mm:ss timestamp')
  const ms = Date.parse(`${timestamp.replace(' ', 'T')}Z`)
  if (!Number.isFinite(ms)) throw new RangeError('Not a YYYY-MM-DD HH:mm:ss timestamp')
  const hex = createHash('sha256')
    .update(`${APP_NAME}${APP_KEY}${ms}Bearer ${token}`, 'utf8')
    .digest('hex')
  return `${hex.slice(0, 9)}cfc${hex.slice(9)}`
}

/** The headers of every `accsmart` call (`PanasonicRequestHeader.get`); no client id on the session login. */
export function apiHeaders(o: {
  now: Date
  token: string
  appVersion: string
  clientId?: string
}): Record<string, string> {
  const timestamp = appTimestamp(o.now)
  return {
    accept: 'application/json; charset=utf-8',
    'content-type': 'application/json',
    'user-agent': API_USER_AGENT,
    'x-app-name': APP_NAME,
    'x-app-timestamp': timestamp,
    'x-app-type': '1',
    'x-app-version': o.appVersion,
    'x-cfc-api-key': cfcApiKey(timestamp, o.token),
    'x-user-authorization-v2': `Bearer ${o.token}`,
    ...(o.clientId ? { 'x-client-id': o.clientId } : {}),
  }
}
```

`src/lib/effects/comfortCloud/html.ts`:
```ts
import { Parser } from 'htmlparser2'

/**
 * The `<input type="hidden">` fields of an Auth0 page, name → value, entities decoded (`wctx` is
 * entity-encoded JSON). A Map, not an object: the names come from a remote page. The values can
 * be tokens: never log them.
 */
export function hiddenInputs(html: string): Map<string, string> {
  const inputs = new Map<string, string>()
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (name === 'input' && attribs.type?.toLowerCase() === 'hidden' && attribs.name) {
          inputs.set(attribs.name, attribs.value ?? '')
        }
      },
    },
    { decodeEntities: true },
  )
  parser.end(html)
  return inputs
}

/** Auth0 Guardian's hosted MFA widget (`window.__g_config = {…}`), detected as upstream starts. */
export function hasGuardianConfig(html: string): boolean {
  return html.includes('__g_config')
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bunx vitest run src/lib/time/utc.test.ts src/lib/effects/comfortCloud/headers.test.ts src/lib/effects/comfortCloud/html.test.ts`
Expected: PASS (12 tests). If `cfcApiKey` differs, re-run the `python3` command from the test's comment; never edit
the expected value to match the code.

- [ ] **Step 6: Commit**

```bash
bun run check
git add package.json bun.lock src/lib/time/utc.ts src/lib/time/utc.test.ts \
  src/lib/effects/comfortCloud/constants.ts src/lib/effects/comfortCloud/headers.ts \
  src/lib/effects/comfortCloud/headers.test.ts src/lib/effects/comfortCloud/html.ts \
  src/lib/effects/comfortCloud/html.test.ts
git commit -m "feat(heat-pumps): add Comfort Cloud signing, HTML and UTC helpers

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Types, `ComfortCloudError`, parsing and synthetic fixtures

**Reviewers:** `code-reviewer` + `test-completeness` (effect adapter / `errors.ts`), told to assume the parser accepts
something it shouldn't or drops something it shouldn't (spec "Calls", "-255").

**Files:**
- Create: `src/lib/effects/comfortCloud/comfortCloud.ts`, `errors.ts`, `parse.ts`, `fixtures.ts`
- Test: `src/lib/effects/comfortCloud/parse.test.ts`

**Interfaces:**
- Consumes: `isUtcDay`, `utcDayBounds` (Task 1); `jsonResponse`, `FakeRoute` (`testing/fakeFetch`); `issuePath`,
  `summarizeIssuePaths` (`~/lib/issuePaths`); `IntegrationError`.
- Produces (`comfortCloud.ts`):
  ```ts
  export type ComfortCloudUnit = { guid: string; name: string; model: string }
  export type ComfortCloudHour = { hourStart: Date; energyKwh: number; heatShare: number | null; coolShare: number | null; setpointC: number | null; insideC: number | null; outsideC: number | null }
  export type ComfortCloudDay = { day: string; energyKwh: number }
  export type ComfortCloudHistory<T> = { registeredOn: string; rows: T[] }
  export interface ComfortCloudCallStats { fetchMs: number; requests: number; retries: number; logins: number }
  export function newCallStats(): ComfortCloudCallStats
  export interface ComfortCloudCallOpts { signal?: AbortSignal; stats?: ComfortCloudCallStats }
  export interface ComfortCloudClient {
    units(o?: ComfortCloudCallOpts): Promise<ComfortCloudUnit[]>
    dayHours(guid: string, utcDay: string, o?: ComfortCloudCallOpts): Promise<ComfortCloudHistory<ComfortCloudHour>>
    monthDays(guid: string, utcMonth: string, o?: ComfortCloudCallOpts): Promise<ComfortCloudHistory<ComfortCloudDay>>
  }
  ```
- Produces (`errors.ts`): `type ComfortCloudOp = 'login' | 'units' | 'history'`,
  `type ComfortCloudCredentialField = Extract<CredentialFieldName, 'user' | 'password'>`,
  `class ComfortCloudError extends IntegrationError` with `(code, op, status?, { cause?, message?, suspectFields? })`.
- Produces (`parse.ts`): `NO_VALUE`, `parseJson(op, text): unknown`, `parseToken(value): string`,
  `parseAccLogin(value): string`, `parseUnits(value): ComfortCloudUnit[]`,
  `parseDayHistory(utcDay, value): ComfortCloudHistory<ComfortCloudHour>`,
  `parseMonthHistory(utcMonth, value): ComfortCloudHistory<ComfortCloudDay>`.
- Produces (`fixtures.ts`, tests only): the `TEST_*` values, `MATSAL_GUID`, `OVERVANING_GUID`, `AQUAREA_GUID`,
  `MODEL`, `ROUTES`, `authRoutes()`, every `*Reply` / `*Body` builder below, `apiError`, `secretsIn`.

- [ ] **Step 1: The types and the error class** (no behaviour of their own; exercised by every later test)

`src/lib/effects/comfortCloud/comfortCloud.ts`:
```ts
/**
 * Panasonic Comfort Cloud: the air-to-air heat pumps' hourly electricity use and temperatures
 * (ADR-0027). Read-only. The client never logs; callers pass a `stats` sink. Hourly rows tell
 * when someone is home and heating: never log or echo them. Unit guids are shortened wherever
 * they are shown and never appear in an error.
 *
 * Step 1a builds the client only. The `comfortCloud` facade (keyedAdapter + notConfigured +
 * adapter selection) arrives with the source literal in step 1b: keyedAdapter takes a
 * CredentialSource.
 */
export type ComfortCloudUnit = {
  guid: string
  name: string
  /** `deviceModuleNumber`, e.g. CS-HZ25ZKE. */
  model: string
}

export type ComfortCloudHour = {
  /** The UTC hour the row covers. */
  hourStart: Date
  energyKwh: number
  /** 0…1 as reported; null when Comfort Cloud had no value. */
  heatShare: number | null
  coolShare: number | null
  setpointC: number | null
  insideC: number | null
  outsideC: number | null
}

export type ComfortCloudDay = {
  /** UTC 'YYYY-MM-DD'. */
  day: string
  energyKwh: number
}

export type ComfortCloudHistory<T> = {
  /** 'YYYY-MM-DD' from `deviceRegisterTime`: the unit's first data day (the backfill's end). */
  registeredOn: string
  /** Ascending; only rows with a value. */
  rows: T[]
}

export interface ComfortCloudCallStats {
  fetchMs: number
  requests: number
  retries: number
  logins: number
}

export function newCallStats(): ComfortCloudCallStats {
  return { fetchMs: 0, requests: 0, retries: 0, logins: 0 }
}

export interface ComfortCloudCallOpts {
  /** Stops this call's own requests. A shared login runs on under its own timeouts. */
  signal?: AbortSignal
  stats?: ComfortCloudCallStats
}

export interface ComfortCloudClient {
  /** Every air conditioner on the account (Aquarea and hot-water tanks skipped). */
  units(o?: ComfortCloudCallOpts): Promise<ComfortCloudUnit[]>
  /** One UTC day's hourly rows. A bad day or guid throws RangeError before any request. */
  dayHours(
    guid: string,
    utcDay: string,
    o?: ComfortCloudCallOpts,
  ): Promise<ComfortCloudHistory<ComfortCloudHour>>
  /** One UTC month's daily totals ('YYYY-MM'): which days have data. */
  monthDays(
    guid: string,
    utcMonth: string,
    o?: ComfortCloudCallOpts,
  ): Promise<ComfortCloudHistory<ComfortCloudDay>>
}
```

`src/lib/effects/comfortCloud/errors.ts`:
```ts
import type { CredentialFieldName } from '~/lib/integrationCredentials'
import type { IntegrationErrorCode } from '~/lib/integrationHealth'
import { IntegrationError } from '../integrationError'

export type ComfortCloudOp = 'login' | 'units' | 'history'

/** The credential fields a Comfort Cloud answer can point at; 1b narrows it to CredentialField<'comfortCloud'>. */
export type ComfortCloudCredentialField = Extract<CredentialFieldName, 'user' | 'password'>

/**
 * The one error the Comfort Cloud client throws. `status` is the HTTP status when there was one.
 * Messages are written for an admin and never carry the user, the password, a token or code, the
 * api key, the client id, a unit guid, raw HTML/JSON or any reading.
 */
export class ComfortCloudError extends IntegrationError {
  override readonly name = 'ComfortCloudError'

  constructor(
    readonly code: IntegrationErrorCode,
    readonly op: ComfortCloudOp,
    readonly status?: number,
    options?: {
      cause?: unknown
      message?: string
      suspectFields?: readonly ComfortCloudCredentialField[]
    },
  ) {
    super(
      options?.message ??
        `Comfort Cloud ${op} failed: ${code}${status === undefined ? '' : ` (HTTP ${status})`}`,
      { cause: options?.cause, suspectFields: options?.suspectFields },
    )
  }
}
```

- [ ] **Step 2: The fixtures** (synthetic; shapes from the 2026-10-08 probe: statuses, cookie names, hidden inputs,
  JSON keys)

`src/lib/effects/comfortCloud/fixtures.ts`:
```ts
// Synthetic Comfort Cloud test data — never real readings, guids, accounts or tokens (the repo
// is public). The shapes follow the 2026-10-08 probe: the Auth0 statuses, Set-Cookie names and
// hidden inputs, and the JSON keys of every answer. Every value is made up.
import { type FakeRoute, jsonResponse } from '../testing/fakeFetch'
import { AUTH_BASE, REDIRECT_URI } from './constants'

export const TEST_USER = 'owner@example.test'
export const TEST_PASSWORD = 'not-a-real-password'
export const TEST_ACCESS_TOKEN = 'test-access-token-0001'
export const TEST_ACCESS_TOKEN_2 = 'test-access-token-0002'
export const TEST_REFRESH_TOKEN = 'test-refresh-token-0001'
export const TEST_ID_TOKEN = 'test-id-token-0001'
export const TEST_CODE = 'test-authorization-code-0001'
export const TEST_CSRF = 'test-csrf-0001'
export const TEST_AUTH0_STATE = 'test-auth0-state-0001'
export const TEST_WRESULT = 'test-wresult-0001'
export const TEST_MFA_TOKEN = 'test-mfa-token-0001'
export const TEST_GUARDIAN_TOKEN = 'test-guardian-request-token-0001'
export const TEST_CLIENT_ID = 'test-client-id-0001'
export const TEST_EXT_USER_ID = 'test-ext-user-id-0001'
export const MATSAL_GUID = 'CS-HZ25ZKE+0000000001'
export const OVERVANING_GUID = 'CS-HZ25ZKE+0000000002'
export const AQUAREA_GUID = 'WH-TEST0000+0000000003'
export const MODEL = 'CS-HZ25ZKE'
export const NO = -255

/** fakeFetch route keys (pathname only; the three hosts share no path). */
export const ROUTES = {
  authorize: 'GET /authorize',
  loginPage: 'GET /login',
  password: 'POST /usernamepassword/login',
  callback: 'POST /login/callback',
  resume: 'GET /authorize/resume',
  token: 'POST /oauth/token',
  accLogin: 'POST /auth/v2/login',
  group: 'GET /device/group',
  history: 'POST /deviceHistoryData',
  playStore: 'GET /store/apps/details',
} as const

const cookie = (name: string, value: string, path = '/') =>
  `${name}=${value}; Path=${path}; Secure; HttpOnly; SameSite=None`

function withCookies(
  status: number,
  body: string,
  headers: Record<string, string>,
  cookies: string[],
): Response {
  const h = new Headers(headers)
  for (const c of cookies) h.append('set-cookie', c)
  return new Response(body, { status, headers: h })
}

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })

export const authorizeRedirect = (
  location = `/login?state=${TEST_AUTH0_STATE}&client=test-client&protocol=oauth2`,
) =>
  withCookies(302, 'Found', { location, 'content-type': 'text/plain; charset=utf-8' }, [
    cookie('auth0', 'test-auth0-cookie'),
    cookie('auth0_compat', 'test-auth0-cookie'),
    cookie('did', 'test-did'),
    cookie('did_compat', 'test-did'),
  ])

export const loginPage = () =>
  withCookies(
    200,
    '<!DOCTYPE html><html><head><title>Sign in</title></head><body><div id="app"></div></body></html>',
    { 'content-type': 'text/html; charset=utf-8' },
    [cookie('_csrf', TEST_CSRF, '/usernamepassword/login')],
  )

/** The password POST's answer: the auto-submitting WS-Fed callback form. */
export const callbackForm = () =>
  html(`<html><head><title>Submit This Form</title></head><body>
<form method="post" name="hiddenform" action="${AUTH_BASE}/login/callback">
<input type="hidden" name="wa" value="wsignin1.0">
<input type="hidden" name="wresult" value="${TEST_WRESULT}&amp;sig">
<input type="hidden" name="wctx" value="{&#34;strategy&#34;:&#34;auth0&#34;,&#34;state&#34;:&#34;${TEST_AUTH0_STATE}&#34;}">
<noscript><p>Script is disabled. Click Submit to continue.</p><input type="submit" value="Submit"></noscript>
</form><script>window.setTimeout(function(){document.forms[0].submit()},0)</script></body></html>`)

/** Classic Universal Login MFA prompt. */
export const mfaTokenForm = () =>
  html(`<html><body><form method="post"><input type="hidden" name="mfa_token" value="${TEST_MFA_TOKEN}">
<input type="hidden" name="state" value="${TEST_AUTH0_STATE}"></form></body></html>`)

/** Auth0 Guardian's hosted widget ("MFA Standard"): an inline JS object, not JSON. */
export const guardianPage = () =>
  html(`<html><body><script>window.__g_config = {
  postActionURL: "${AUTH_BASE}/continue?state=${TEST_AUTH0_STATE}",
  serviceUrl: "https://mfa.example.test", // comment
  requestToken: "${TEST_GUARDIAN_TOKEN}",
  stateCheckingMechanism: "polling"
};</script></body></html>`)

export const callbackRedirect = () =>
  withCookies(
    302,
    'Found',
    { location: `/authorize/resume?state=${TEST_AUTH0_STATE}` },
    [cookie('auth0', 'test-auth0-callback'), cookie('auth0_compat', 'test-auth0-callback')],
  )

export const resumeRedirect = (location = `${REDIRECT_URI}?code=${TEST_CODE}&state=test-state`) =>
  withCookies(302, 'Found', { location }, [cookie('auth0', 'test-auth0-resumed')])

export const tokenReply = (accessToken = TEST_ACCESS_TOKEN) =>
  jsonResponse({
    access_token: accessToken,
    refresh_token: TEST_REFRESH_TOKEN,
    id_token: TEST_ID_TOKEN,
    scope: 'openid offline_access comfortcloud.control a2w.control',
    expires_in: 86400,
    token_type: 'Bearer',
  })

/** Auth0's refusal; the description echoes the account to prove it never reaches an error. */
export const rejectedPassword = (status = 401) =>
  jsonResponse(
    {
      name: 'ValidationError',
      code: 'invalid_user_password',
      description: `Wrong email or password for ${TEST_USER}`,
      statusCode: 400,
    },
    { status },
  )

/** The six Auth0 routes of a password login; tokens are handed out in order (the last repeats). */
export function authRoutes(tokens: string[] = [TEST_ACCESS_TOKEN, TEST_ACCESS_TOKEN_2]) {
  let issued = 0
  const routes: Record<string, FakeRoute> = {
    [ROUTES.authorize]: () => authorizeRedirect(),
    [ROUTES.loginPage]: () => loginPage(),
    [ROUTES.password]: () => callbackForm(),
    [ROUTES.callback]: () => callbackRedirect(),
    [ROUTES.resume]: () => resumeRedirect(),
    [ROUTES.token]: () => tokenReply(tokens[Math.min(issued++, tokens.length - 1)]),
  }
  return routes
}

export const accLoginReply = () =>
  jsonResponse({ country: 'SE', extUsrId: TEST_EXT_USER_ID, clientId: TEST_CLIENT_ID, language: 0 })

/** An accsmart error body: `{ code, message }` with the status (4106 = newer app, 4103 = terms). */
export const apiError = (status: number, code: number) =>
  jsonResponse({ code, message: `test error ${code}` }, { status })

const acDevice = (deviceGuid: string, deviceName: string) => ({
  deviceGuid,
  deviceType: '1',
  deviceName,
  permission: 3,
  temperatureUnit: 0,
  summerHouse: 0,
  nanoeStandAlone: false,
  autoMode: true,
  powerConsumptionFlg: true,
  modeAvlList: { autoMode: 1 },
  parameters: {
    operate: 1,
    operationMode: 3,
    temperatureSet: 21,
    fanSpeed: 0,
    fanAutoMode: 1,
    airSwingLR: 2,
    airSwingUD: 0,
    ecoFunctionData: 0,
    ecoMode: 0,
    ecoNavi: 1,
    nanoe: 1,
    iAuto: 0,
    airDirection: 0,
    lastSettingMode: 0,
    airQuality: 0,
  },
  deviceModuleNumber: MODEL,
  deviceHashGuid: '0'.repeat(64),
  modelVersion: 0,
  coordinableFlg: false,
  pairedFlg: false,
  devicePositionId: 0,
})

export const deviceGroupBody = () => ({
  uiFlg: false,
  groupCount: 2,
  groupList: [
    {
      groupId: 1,
      groupName: 'Test house',
      pairingList: [],
      deviceList: [acDevice(MATSAL_GUID, 'Matsal'), acDevice(OVERVANING_GUID, 'Övervåning')],
    },
    {
      groupId: 2,
      groupName: 'Test garage',
      pairingList: [],
      deviceList: [
        { deviceGuid: AQUAREA_GUID, deviceType: '2', deviceName: 'Aquarea', deviceModuleNumber: 'WH-TEST', parameters: {} },
      ],
    },
  ],
})
export const deviceGroupReply = () => jsonResponse(deviceGroupBody())

const ELECTRIC_RATE = {
  weekdayBaseRate: NO,
  currency: 'kr',
  weekendBaseRate: NO,
  weekendDifferentRateTime: [],
  weekdayDifferentRateTime: [],
}

/** Synthetic kWh for hour `h` (distinct per hour, so a shifted hour shows). */
export const syntheticKwh = (h: number) => Math.round((0.05 + h * 0.01) * 1000) / 1000

/** One day-mode row as the API sends it; `filled: false` is an hour not reached yet (all -255). */
export function dayRow(day: string, h: number, filled = true): Record<string, unknown> {
  const v = (x: number) => (filled ? x : NO)
  return {
    dataTime: `${day.replaceAll('-', '')} ${String(h).padStart(2, '0')}`,
    averageSettingTemp: v(21),
    averageInsideTemp: v(20 + (h % 4) * 0.25),
    averageOutsideTemp: v(-3 + h * 0.25),
    consumption: v(syntheticKwh(h)),
    cost: NO,
    heatConsumptionRate: v(1),
    coolConsumptionRate: v(0),
    heatCostRate: NO,
    coolCostRate: NO,
  }
}

export function dayHistoryBody(
  day: string,
  o: {
    filledHours?: number
    /** `null` omits the field. */
    registerTime?: string | null
    /** 0 = Celsius (the default); `null` omits the field. */
    temperatureUnit?: number | null
    row?: (row: Record<string, unknown>, h: number) => Record<string, unknown>
  } = {},
) {
  const filled = o.filledHours ?? 24
  const rows = Array.from({ length: 24 }, (_, h) => {
    const row = dayRow(day, h, h < filled)
    return o.row ? o.row(row, h) : row
  })
  return {
    ...(o.temperatureUnit === null ? {} : { temperatureUnit: o.temperatureUnit ?? 0 }),
    ...(o.registerTime === null ? {} : { deviceRegisterTime: o.registerTime ?? '20241031' }),
    historyDataList: rows,
    electricRate: ELECTRIC_RATE,
  }
}
export const dayHistoryReply = (day: string, o?: Parameters<typeof dayHistoryBody>[1]) =>
  jsonResponse(dayHistoryBody(day, o))

/** One row per day of `month` ('YYYY-MM'); days from `filledDays` + 1 on are -255. */
export function monthHistoryBody(
  month: string,
  o: { filledDays?: number; emptyDays?: number[]; registerTime?: string; temperatureUnit?: number } = {},
) {
  const [y, m] = month.split('-').map(Number)
  const length = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const filled = o.filledDays ?? length
  const rows = Array.from({ length }, (_, i) => {
    const d = i + 1
    const has = d <= filled && !o.emptyDays?.includes(d)
    const v = (x: number) => (has ? x : NO)
    return {
      dataTime: `${month.replace('-', '')}${String(d).padStart(2, '0')}`,
      averageSettingTemp: v(21),
      averageInsideTemp: v(20.5),
      averageOutsideTemp: v(-2 + d * 0.5),
      consumption: v(Math.round((2.5 + d * 0.1) * 1000) / 1000),
      cost: NO,
      heatConsumptionRate: v(1),
      coolConsumptionRate: v(0),
      heatCostRate: NO,
      coolCostRate: NO,
    }
  })
  return {
    temperatureUnit: o.temperatureUnit ?? 0,
    deviceRegisterTime: o.registerTime ?? '20241031',
    historyDataList: rows,
    electricRate: ELECTRIC_RATE,
  }
}
export const monthHistoryReply = (month: string, o?: Parameters<typeof monthHistoryBody>[1]) =>
  jsonResponse(monthHistoryBody(month, o))

/** A trimmed Play Store page carrying `version` where upstream's regex finds it. */
export const playStorePage = (version: string) =>
  html(`<html><script>AF_initDataCallback({key: 'ds:5', data:[[["${version}"]],[[[33]]]]});</script></html>`)

/** Values that must never appear in an error (message, cause or stack). */
export const SECRETS = [
  TEST_USER,
  TEST_PASSWORD,
  TEST_ACCESS_TOKEN,
  TEST_ACCESS_TOKEN_2,
  TEST_REFRESH_TOKEN,
  TEST_ID_TOKEN,
  TEST_CODE,
  TEST_CSRF,
  TEST_WRESULT,
  TEST_MFA_TOKEN,
  TEST_GUARDIAN_TOKEN,
  TEST_CLIENT_ID,
  TEST_EXT_USER_ID,
  MATSAL_GUID,
  OVERVANING_GUID,
  'Bearer ',
  '<html',
  '<input',
]

/** The SECRETS (plus `extra`) found in an error's message, cause or stack; [] when clean. */
export function secretsIn(err: unknown, extra: string[] = []): string[] {
  const e = err as { message?: unknown; cause?: unknown; stack?: unknown } | null
  const cause = e?.cause as { message?: unknown } | undefined
  const text = [
    String(e?.message),
    JSON.stringify(e?.cause ?? null),
    String(cause?.message),
    String(e?.stack),
  ].join(' ')
  return [...SECRETS, ...extra].filter((s) => text.includes(s))
}
```

- [ ] **Step 3: Write the failing parse tests**

`src/lib/effects/comfortCloud/parse.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import { ComfortCloudError } from './errors'
import {
  AQUAREA_GUID,
  dayHistoryBody,
  dayRow,
  deviceGroupBody,
  MATSAL_GUID,
  MODEL,
  monthHistoryBody,
  NO,
  OVERVANING_GUID,
  secretsIn,
  syntheticKwh,
} from './fixtures'
import {
  parseAccLogin,
  parseDayHistory,
  parseJson,
  parseMonthHistory,
  parseToken,
  parseUnits,
} from './parse'

const caught = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    return e as ComfortCloudError
  }
  throw new Error('expected a throw')
}
const HOUR = 3_600_000

describe('units', () => {
  test('lists the air conditioners in order, skipping Aquarea', () => {
    expect(parseUnits(deviceGroupBody())).toEqual([
      { guid: MATSAL_GUID, name: 'Matsal', model: MODEL },
      { guid: OVERVANING_GUID, name: 'Övervåning', model: MODEL },
    ])
  })

  test('skips devices without parameters, the HWS tank, nulls and repeats; tolerates no groups', () => {
    // A loose view of the fixture: the test adds devices of other shapes on purpose.
    const body = deviceGroupBody() as unknown as { groupList: { deviceList: unknown[] }[] }
    body.groupList[1].deviceList.push(
      { deviceGuid: 'HWS+1', deviceType: '11', deviceName: 'Tank', deviceModuleNumber: 'HE', parameters: {} },
      { deviceGuid: 'NOPARAMS+1', deviceType: '1', deviceName: 'X', deviceModuleNumber: MODEL },
      null,
      { ...(body.groupList[0].deviceList[0] as object) },
    )
    expect(parseUnits(body).map((u) => u.guid)).toEqual([MATSAL_GUID, OVERVANING_GUID])
    expect(parseUnits({ uiFlg: false, groupCount: 0 })).toEqual([])
    expect(parseUnits({ groupList: [{ deviceList: null }] })).toEqual([])
    expect(parseUnits(body).some((u) => u.guid === AQUAREA_GUID)).toBe(false)
  })

  test('a nameless unit is named by its model', () => {
    const body = deviceGroupBody() as unknown as { groupList: { deviceList: { deviceName: string | null }[] }[] }
    body.groupList[0].deviceList[0].deviceName = null
    expect(parseUnits(body)[0]).toEqual({ guid: MATSAL_GUID, name: MODEL, model: MODEL })
  })

  test('a wrong shape is unexpected_response naming the path, never a value', () => {
    const err = caught(() => parseUnits({ groupList: [{ deviceList: [{ deviceGuid: 42 }] }] }))
    expect(err).toBeInstanceOf(ComfortCloudError)
    expect(err).toMatchObject({ code: 'unexpected_response', op: 'units' })
    expect(err.message).toContain('groupList.0.deviceList.0.deviceGuid')
    expect(err.message).not.toContain('42')
  })
})

describe('day history', () => {
  test('a full day is 24 exact UTC hours with every value mapped', () => {
    const h = parseDayHistory('2026-06-10', dayHistoryBody('2026-06-10'))
    expect(h.registeredOn).toBe('2024-10-31')
    expect(h.rows).toHaveLength(24)
    expect(h.rows[0]).toEqual({
      hourStart: new Date('2026-06-10T00:00:00Z'),
      energyKwh: syntheticKwh(0),
      heatShare: 1,
      coolShare: 0,
      setpointC: 21,
      insideC: 20,
      outsideC: -3,
    })
    expect(h.rows[23].hourStart).toEqual(new Date('2026-06-10T23:00:00Z'))
  })

  test('both DST days are 24 UTC hours', () => {
    for (const day of ['2025-10-26', '2026-03-29']) {
      const rows = parseDayHistory(day, dayHistoryBody(day)).rows
      expect(rows).toHaveLength(24)
      expect(rows[23].hourStart.getTime() - rows[0].hourStart.getTime()).toBe(23 * HOUR)
    }
  })

  test('future hours (consumption -255) are dropped', () => {
    const rows = parseDayHistory('2026-06-10', dayHistoryBody('2026-06-10', { filledHours: 10 })).rows
    expect(rows.map((r) => r.hourStart.getUTCHours())).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  test('a -255 temperature or share with a real kWh keeps the kWh and stores null', () => {
    const body = dayHistoryBody('2026-06-10', {
      row: (row, h) =>
        h === 3
          ? { ...row, averageInsideTemp: NO, averageOutsideTemp: NO, averageSettingTemp: NO, heatConsumptionRate: NO, coolConsumptionRate: NO }
          : row,
    })
    expect(parseDayHistory('2026-06-10', body).rows[3]).toEqual({
      hourStart: new Date('2026-06-10T03:00:00Z'),
      energyKwh: syntheticKwh(3),
      heatShare: null,
      coolShare: null,
      setpointC: null,
      insideC: null,
      outsideC: null,
    })
  })

  test('absent optional fields are null; other values pass through for the service to judge', () => {
    const body = dayHistoryBody('2026-06-10', {
      row: (row, h) => (h === 0 ? { dataTime: row.dataTime, consumption: 0.2 } : { ...row, averageOutsideTemp: -40.5 }),
    })
    const rows = parseDayHistory('2026-06-10', body).rows
    expect(rows[0]).toMatchObject({ energyKwh: 0.2, heatShare: null, insideC: null })
    expect(rows[1].outsideC).toBe(-40.5)
  })

  test('rows arrive in any order and come back ascending', () => {
    const body = dayHistoryBody('2026-06-10')
    body.historyDataList.reverse()
    const rows = parseDayHistory('2026-06-10', body).rows
    expect(rows.map((r) => r.hourStart.getUTCHours())).toEqual(Array.from({ length: 24 }, (_, h) => h))
  })

  test('a row of another day, or an impossible hour, is unexpected_response', () => {
    for (const dataTime of ['20260611 00', '20260609 23', '20260610 24', '20260610', '2026-06-10 01']) {
      const body = dayHistoryBody('2026-06-10', { row: (row, h) => (h === 5 ? { ...row, dataTime } : row) })
      const err = caught(() => parseDayHistory('2026-06-10', body))
      expect(err, dataTime).toMatchObject({ code: 'unexpected_response', op: 'history' })
      expect(err.message).toContain('row 5')
      expect(err.message).not.toContain(dataTime)
    }
  })

  test('a repeated hour is unexpected_response', () => {
    const body = dayHistoryBody('2026-06-10', { row: (row, h) => (h === 7 ? dayRow('2026-06-10', 6) : row) })
    expect(caught(() => parseDayHistory('2026-06-10', body)).message).toContain('repeats an hour')
  })

  test('a missing or impossible deviceRegisterTime is unexpected_response', () => {
    for (const registerTime of [null, '2024103', '20241332', '2024-10-31']) {
      const err = caught(() => parseDayHistory('2026-06-10', dayHistoryBody('2026-06-10', { registerTime })))
      expect(err, String(registerTime)).toMatchObject({ code: 'unexpected_response', op: 'history' })
    }
  })

  test('temperatures in anything but Celsius fail the call, naming the unit setting', () => {
    for (const temperatureUnit of [1, 2]) {
      const body = dayHistoryBody('2026-06-10', { temperatureUnit })
      const err = caught(() => parseDayHistory('2026-06-10', body))
      expect(err, String(temperatureUnit)).toMatchObject({ code: 'unexpected_response', op: 'history' })
      expect(err.message).toContain('temperatureUnit')
      expect(err.message).toContain('Celsius')
    }
    const month = monthHistoryBody('2026-06', { temperatureUnit: 1 })
    expect(caught(() => parseMonthHistory('2026-06', month)).message).toContain('Celsius')
    // a missing unit is a shape error, not a silent Celsius
    const missing = dayHistoryBody('2026-06-10', { temperatureUnit: null })
    expect(caught(() => parseDayHistory('2026-06-10', missing)).message).toContain('temperatureUnit')
  })

  test('more rows than any day has, or not an object, is unexpected_response', () => {
    const body = dayHistoryBody('2026-06-10')
    body.historyDataList = [...body.historyDataList, ...body.historyDataList]
    expect(caught(() => parseDayHistory('2026-06-10', body)).code).toBe('unexpected_response')
    expect(caught(() => parseDayHistory('2026-06-10', 'x')).code).toBe('unexpected_response')
  })
})

describe('month history', () => {
  test('one row per day with data, -255 days dropped, ascending', () => {
    const h = parseMonthHistory('2026-06', monthHistoryBody('2026-06', { filledDays: 10, emptyDays: [4] }))
    expect(h.registeredOn).toBe('2024-10-31')
    expect(h.rows.map((r) => r.day)).toEqual([
      '2026-06-01', '2026-06-02', '2026-06-03', '2026-06-05', '2026-06-06',
      '2026-06-07', '2026-06-08', '2026-06-09', '2026-06-10',
    ])
    expect(h.rows[0]).toEqual({ day: '2026-06-01', energyKwh: 2.6 })
  })

  test('a day of another month, an impossible day or a repeated day is unexpected_response', () => {
    for (const dataTime of ['20260701', '20260631', '20260600', '2026060']) {
      const body = monthHistoryBody('2026-06')
      body.historyDataList[2] = { ...body.historyDataList[2], dataTime }
      const err = caught(() => parseMonthHistory('2026-06', body))
      expect(err, dataTime).toMatchObject({ code: 'unexpected_response', op: 'history' })
    }
    const body = monthHistoryBody('2026-06')
    body.historyDataList[3] = { ...body.historyDataList[3], dataTime: '20260603' }
    expect(caught(() => parseMonthHistory('2026-06', body)).message).toContain('repeats a day')
  })
})

describe('login answers', () => {
  test('the token and the client id', () => {
    expect(parseToken({ access_token: 'tok', expires_in: 86400 })).toBe('tok')
    expect(parseAccLogin({ country: 'SE', clientId: 'cid', language: 0 })).toBe('cid')
  })

  test('a missing token or client id is unexpected_response on login, naming no value', () => {
    for (const fn of [() => parseToken({ refresh_token: 'r-secret' }), () => parseAccLogin({ extUsrId: 'u-secret' })]) {
      const err = caught(fn)
      expect(err).toMatchObject({ code: 'unexpected_response', op: 'login' })
      expect(secretsIn(err, ['r-secret', 'u-secret'])).toEqual([])
    }
  })

  test('a body that is not JSON is unexpected_response', () => {
    expect(caught(() => parseJson('units', '<html>oops</html>'))).toMatchObject({
      code: 'unexpected_response',
      op: 'units',
      message: 'Comfort Cloud units response is not valid JSON',
    })
  })
})
```

- [ ] **Step 4: Run them to verify they fail**

Run: `bunx vitest run src/lib/effects/comfortCloud/parse.test.ts`
Expected: FAIL — `Failed to resolve import "./parse"`.

- [ ] **Step 5: Implement `parse.ts`**

`src/lib/effects/comfortCloud/parse.ts`:
```ts
import { z } from 'zod'
import { issuePath, summarizeIssuePaths } from '~/lib/issuePaths'
import { isUtcDay, utcDayBounds } from '~/lib/time/utc'
import type {
  ComfortCloudDay,
  ComfortCloudHistory,
  ComfortCloudHour,
  ComfortCloudUnit,
} from './comfortCloud'
import { ComfortCloudError, type ComfortCloudOp } from './errors'

/** Comfort Cloud's "no value" in any numeric history field (hours not reached, `cost` without a tariff). */
export const NO_VALUE = -255
/** Device types upstream treats as not an air conditioner: Aquarea (2), the HWS tank (11). */
const NON_AC_DEVICE_TYPES = new Set(['2', '11'])
const HOUR_MS = 3_600_000
const MAX_GROUPS = 50
const MAX_DEVICES = 50
/** A day answer has 24 rows, a month answer ≤ 31: anything far beyond is not a history. */
const MAX_HISTORY_ROWS = 40
/** `temperatureUnit` of an account set to Celsius (the probe's value); anything else fails the call. */
const CELSIUS = 0

function unexpected(op: ComfortCloudOp, message: string): ComfortCloudError {
  return new ComfortCloudError('unexpected_response', op, undefined, { message })
}

function parse<T>(op: ComfortCloudOp, schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  const at = summarizeIssuePaths(parsed.error.issues.map((i) => issuePath(i.path)))
  throw unexpected(op, `Comfort Cloud ${op} response has an unexpected shape at: ${at}`)
}

export function parseJson(op: ComfortCloudOp, text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw unexpected(op, `Comfort Cloud ${op} response is not valid JSON`)
  }
}

// ---- login ------------------------------------------------------------------

const tokenSchema = z.object({ access_token: z.string().min(1).max(16_384) })

/** `/oauth/token` → the access token (the refresh and id tokens are ignored, never kept). */
export function parseToken(value: unknown): string {
  return parse('login', tokenSchema, value).access_token
}

const accLoginSchema = z.object({ clientId: z.string().min(1).max(256) })

/** `/auth/v2/login` → the `clientId` sent as `x-client-id`. */
export function parseAccLogin(value: unknown): string {
  return parse('login', accLoginSchema, value).clientId
}

// ---- units ------------------------------------------------------------------

const optionalText = (max: number) => z.string().max(max).nullish()
const deviceSchema = z.object({
  deviceGuid: z.string().min(1).max(128),
  deviceType: optionalText(16),
  deviceName: optionalText(200),
  deviceModuleNumber: optionalText(100),
  parameters: z.record(z.string(), z.unknown()).nullish(),
})
const groupsSchema = z.object({
  groupList: z
    .array(z.object({ deviceList: z.array(deviceSchema.nullable()).max(MAX_DEVICES).nullish() }))
    .max(MAX_GROUPS)
    .nullish(),
})

/** Every air conditioner of every group, once, in Comfort Cloud's order. */
export function parseUnits(value: unknown): ComfortCloudUnit[] {
  const { groupList } = parse('units', groupsSchema, value)
  const units = new Map<string, ComfortCloudUnit>()
  for (const group of groupList ?? []) {
    for (const device of group.deviceList ?? []) {
      // Upstream's `is_valid`: an air conditioner reports `parameters`; Aquarea and HWS are skipped.
      if (!device?.parameters || NON_AC_DEVICE_TYPES.has(device.deviceType ?? '')) continue
      if (units.has(device.deviceGuid)) continue
      const model = device.deviceModuleNumber?.trim() ?? ''
      const name = device.deviceName?.trim() || model || 'Comfort Cloud'
      units.set(device.deviceGuid, { guid: device.deviceGuid, name, model })
    }
  }
  return [...units.values()]
}

// ---- history ----------------------------------------------------------------

const numeric = z.number()
const rowSchema = z.object({
  dataTime: z.string().max(32),
  consumption: numeric,
  heatConsumptionRate: numeric.optional(),
  coolConsumptionRate: numeric.optional(),
  averageSettingTemp: numeric.optional(),
  averageInsideTemp: numeric.optional(),
  averageOutsideTemp: numeric.optional(),
})
const historySchema = z.object({
  temperatureUnit: z.int(),
  deviceRegisterTime: z.string().regex(/^\d{8}$/),
  historyDataList: z.array(rowSchema).max(MAX_HISTORY_ROWS),
})

/** null for "no value" or an absent field; anything else as sent (the service range-checks it). */
const orNull = (v: number | undefined): number | null => (v === undefined || v === NO_VALUE ? null : v)

/** 'YYYYMMDD' → 'YYYY-MM-DD' (not validated). */
const dashed = (compact: string) => `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`

function readHistory(value: unknown) {
  const history = parse('history', historySchema, value)
  // The columns are °C: an account set to Fahrenheit would store °F in them.
  if (history.temperatureUnit !== CELSIUS) {
    throw unexpected(
      'history',
      'Comfort Cloud reports temperatures in a unit other than Celsius (temperatureUnit); set the account to °C in the Comfort Cloud app',
    )
  }
  const registeredOn = dashed(history.deviceRegisterTime)
  if (!isUtcDay(registeredOn)) {
    throw unexpected('history', 'Comfort Cloud history has an impossible deviceRegisterTime')
  }
  return { registeredOn, rows: history.historyDataList }
}

/**
 * A `dataMode` 0 answer for UTC `utcDay`. Every row must be one hour of that day, once; rows
 * with `consumption < 0` (an hour not reached yet) are dropped.
 */
export function parseDayHistory(
  utcDay: string,
  value: unknown,
): ComfortCloudHistory<ComfortCloudHour> {
  const { startMs } = utcDayBounds(utcDay)
  const compact = utcDay.replaceAll('-', '')
  const { registeredOn, rows } = readHistory(value)
  const seen = new Set<number>()
  const hours: ComfortCloudHour[] = []
  for (const [i, row] of rows.entries()) {
    const match = /^(\d{8}) (\d{2})$/.exec(row.dataTime)
    const hour = match ? Number(match[2]) : Number.NaN
    if (!match || match[1] !== compact || !(hour <= 23)) {
      throw unexpected('history', `Comfort Cloud day history row ${i} is not an hour of the requested day`)
    }
    if (seen.has(hour)) throw unexpected('history', `Comfort Cloud day history row ${i} repeats an hour`)
    seen.add(hour)
    if (row.consumption < 0) continue
    hours.push({
      hourStart: new Date(startMs + hour * HOUR_MS),
      energyKwh: row.consumption,
      heatShare: orNull(row.heatConsumptionRate),
      coolShare: orNull(row.coolConsumptionRate),
      setpointC: orNull(row.averageSettingTemp),
      insideC: orNull(row.averageInsideTemp),
      outsideC: orNull(row.averageOutsideTemp),
    })
  }
  hours.sort((a, b) => a.hourStart.getTime() - b.hourStart.getTime())
  return { registeredOn, rows: hours }
}

/**
 * A `dataMode` 2 answer for UTC `utcMonth` ('YYYY-MM'). Every row must be one day of that month,
 * once; days with `consumption < 0` are dropped.
 */
export function parseMonthHistory(
  utcMonth: string,
  value: unknown,
): ComfortCloudHistory<ComfortCloudDay> {
  const compact = utcMonth.replace('-', '')
  const { registeredOn, rows } = readHistory(value)
  const seen = new Set<string>()
  const days: ComfortCloudDay[] = []
  for (const [i, row] of rows.entries()) {
    const day = dashed(row.dataTime)
    if (!/^\d{8}$/.test(row.dataTime) || !row.dataTime.startsWith(compact) || !isUtcDay(day)) {
      throw unexpected('history', `Comfort Cloud month history row ${i} is not a day of the requested month`)
    }
    if (seen.has(day)) throw unexpected('history', `Comfort Cloud month history row ${i} repeats a day`)
    seen.add(day)
    if (row.consumption < 0) continue
    days.push({ day, energyKwh: row.consumption })
  }
  days.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  return { registeredOn, rows: days }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bunx vitest run src/lib/effects/comfortCloud/parse.test.ts`
Expected: PASS. Then `bun run typecheck` — the parse tests' loose fixture views (`as unknown as …`) are the
only escapes.

- [ ] **Step 7: Commit**

```bash
bun run check
git add src/lib/effects/comfortCloud/comfortCloud.ts src/lib/effects/comfortCloud/errors.ts \
  src/lib/effects/comfortCloud/parse.ts src/lib/effects/comfortCloud/parse.test.ts \
  src/lib/effects/comfortCloud/fixtures.ts
git commit -m "feat(heat-pumps): parse Comfort Cloud units and history

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The transport and the password login (steps 1–4)

**Reviewers:** `code-reviewer` + `test-completeness` (effect adapter). `code-reviewer` is also told to diff
`auth.ts` against upstream's `PanasonicAuthentication.authenticate` / `_authorize` / `_login` /
`_request_new_token` (password path only) and to hunt for any path where a secret reaches a message, a cause, or a
non-Panasonic host.

**Files:**
- Create: `src/lib/effects/comfortCloud/request.ts`, `src/lib/effects/comfortCloud/auth.ts`
- Test: `src/lib/effects/comfortCloud/auth.test.ts`

**Interfaces:**
- Consumes: constants, `hiddenInputs`, `hasGuardianConfig` (Task 1); `ComfortCloudError`, `parseJson`,
  `parseToken`, `newCallStats`, fixtures (Task 2); `fetchWithRetry`, `discard`, `networkCause`.
- Produces:
  - `type SendOpts = { stats: ComfortCloudCallStats; signal?: AbortSignal }`
  - `send(fetch: typeof globalThis.fetch, op: ComfortCloudOp, url: string, init: RequestInit, o: SendOpts): Promise<Response>`
  - `statusError(op: ComfortCloudOp, res: Response): Promise<ComfortCloudError>`,
    `errorForStatus(op: ComfortCloudOp, status: number): ComfortCloudError`
  - `type LoginDeps = { fetch: typeof globalThis.fetch; user: string; password: string; stats: ComfortCloudCallStats }`
  - `passwordLogin(d: LoginDeps): Promise<string>` (the access token)
  - `pkceChallenge(verifier: string): string`, `randomString(length: number): string`

- [ ] **Step 1: Write the failing tests**

`src/lib/effects/comfortCloud/auth.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { type FakeRoute, fakeFetch } from '../testing/fakeFetch'
import { passwordLogin, pkceChallenge, randomString } from './auth'
import { newCallStats } from './comfortCloud'
import {
  APP_CLIENT_ID,
  AUDIENCE,
  AUTH_API_USER_AGENT,
  AUTH_BASE,
  AUTH_BROWSER_USER_AGENT,
  AUTH0_CLIENT,
  REDIRECT_URI,
  SCOPE,
} from './constants'
import type { ComfortCloudError } from './errors'
import {
  authorizeRedirect,
  authRoutes,
  guardianPage,
  mfaTokenForm,
  ROUTES,
  rejectedPassword,
  resumeRedirect,
  secretsIn,
  TEST_ACCESS_TOKEN,
  TEST_AUTH0_STATE,
  TEST_CODE,
  TEST_CSRF,
  TEST_PASSWORD,
  TEST_USER,
  TEST_WRESULT,
  tokenReply,
} from './fixtures'

// ky waits on real timers: fake them, jumping straight to the next one (as emaldo.test.ts).
const NOW = new Date('2026-06-11T08:00:00.123Z')
beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
  vi.setTimerTickMode('nextTimerAsync')
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function login(overrides: Partial<Record<string, FakeRoute>> = {}) {
  const routes = authRoutes()
  for (const [key, route] of Object.entries(overrides)) if (route) routes[key] = route
  const f = fakeFetch(routes)
  const stats = newCallStats()
  const run = () => passwordLogin({ fetch: f.fetch, user: TEST_USER, password: TEST_PASSWORD, stats })
  return { f, stats, run }
}
const caught = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('expected a rejection')
    },
    (e: unknown) => e as ComfortCloudError,
  )
const keys = (f: ReturnType<typeof fakeFetch>) => f.calls.map((r) => `${r.method} ${new URL(r.url).pathname}`)

describe('PKCE helpers', () => {
  test('the S256 challenge matches upstream for a fixed verifier', () => {
    // python3 -I -c "import hashlib,base64;v='0123456789abcdefghijABCDEFGHIJklmnopqrstUVW';print(base64.urlsafe_b64encode(hashlib.sha256(v.encode()).digest()).split(b'=')[0].decode())"
    expect(pkceChallenge('0123456789abcdefghijABCDEFGHIJklmnopqrstUVW')).toBe(
      'uXi7Kb2X0AcU627-0OIOlA_yXr1Ii5m7cRDeVLUbxxA',
    )
  })

  test('random strings are alphanumeric, of the asked length, and differ', () => {
    const a = randomString(43)
    expect(a).toMatch(/^[A-Za-z0-9]{43}$/)
    expect(randomString(43)).not.toBe(a)
  })
})

describe('the happy path', () => {
  test('six Auth0 requests, redirects never auto-followed, the access token back', async () => {
    const { f, stats, run } = login()
    expect(await run()).toBe(TEST_ACCESS_TOKEN)
    expect(keys(f)).toEqual([
      ROUTES.authorize,
      ROUTES.loginPage,
      ROUTES.password,
      ROUTES.callback,
      ROUTES.resume,
      ROUTES.token,
    ])
    expect(f.calls.every((r) => r.redirect === 'manual')).toBe(true)
    expect(new Set(f.calls.map((r) => new URL(r.url).origin))).toEqual(new Set([AUTH_BASE]))
    expect(stats.requests).toBe(6)
  })

  test('the authorize parameters and a PKCE challenge for the verifier it exchanges', async () => {
    const { f, run } = login()
    await run()
    const authorize = f.callsTo(ROUTES.authorize)[0]
    const q = new URL(authorize.url).searchParams
    const token = (await f.callsTo(ROUTES.token)[0].clone().json()) as Record<string, string>
    expect(token.code_verifier).toMatch(/^[A-Za-z0-9]{43}$/)
    expect(q.get('code_challenge')).toBe(pkceChallenge(token.code_verifier))
    expect(q.get('state')).toMatch(/^[A-Za-z0-9]{20}$/)
    expect(Object.fromEntries(q)).toMatchObject({
      scope: SCOPE,
      audience: AUDIENCE,
      protocol: 'oauth2',
      response_type: 'code',
      code_challenge_method: 'S256',
      auth0Client: AUTH0_CLIENT,
      client_id: APP_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
    })
    expect(authorize.headers.get('user-agent')).toBe(AUTH_API_USER_AGENT)
    expect(token).toEqual({
      scope: 'openid',
      client_id: APP_CLIENT_ID,
      grant_type: 'authorization_code',
      code: TEST_CODE,
      redirect_uri: REDIRECT_URI,
      code_verifier: token.code_verifier,
    })
    expect(f.callsTo(ROUTES.token)[0].headers.get('auth0-client')).toBe(AUTH0_CLIENT)
  })

  test('carries the Auth0 cookies by path and posts the _csrf and state it was given', async () => {
    const { f, run } = login()
    await run()
    expect(f.callsTo(ROUTES.loginPage)[0].headers.get('cookie')).toContain('did=test-did')
    const post = f.callsTo(ROUTES.password)[0]
    expect(post.headers.get('cookie')).toContain(`_csrf=${TEST_CSRF}`)
    expect(post.headers.get('cookie')).toContain('auth0=test-auth0-cookie')
    expect(post.headers.get('auth0-client')).toBe(AUTH0_CLIENT)
    expect(post.headers.get('user-agent')).toBe(AUTH_API_USER_AGENT)
    expect(await post.clone().json()).toEqual({
      client_id: APP_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      tenant: 'pdpauthglb-a1',
      response_type: 'code',
      scope: SCOPE,
      audience: AUDIENCE,
      _csrf: TEST_CSRF,
      state: TEST_AUTH0_STATE,
      _intstate: 'deprecated',
      username: TEST_USER,
      password: TEST_PASSWORD,
      lang: 'en',
      connection: 'PanasonicID-Authentication',
    })
    // _csrf is scoped to /usernamepassword/login: the jar must not send it anywhere else
    expect(f.callsTo(ROUTES.callback)[0].headers.get('cookie')).not.toContain('_csrf')
  })

  test('posts the hidden callback form decoded, then follows its redirect with the updated cookie', async () => {
    const { f, run } = login()
    await run()
    const cb = f.callsTo(ROUTES.callback)[0]
    expect(cb.headers.get('content-type')).toContain('application/x-www-form-urlencoded')
    expect(cb.headers.get('user-agent')).toBe(AUTH_BROWSER_USER_AGENT)
    expect(Object.fromEntries(new URLSearchParams(await cb.clone().text()))).toEqual({
      wa: 'wsignin1.0',
      wresult: `${TEST_WRESULT}&sig`,
      wctx: `{"strategy":"auth0","state":"${TEST_AUTH0_STATE}"}`,
    })
    const resume = f.callsTo(ROUTES.resume)[0]
    expect(new URL(resume.url).searchParams.get('state')).toBe(TEST_AUTH0_STATE)
    expect(resume.headers.get('cookie')).toContain('auth0=test-auth0-callback')
  })

  test('an authorize redirect straight to the app with a code skips to the token exchange', async () => {
    const { f, run } = login({
      [ROUTES.authorize]: () => authorizeRedirect(`${REDIRECT_URI}?code=${TEST_CODE}&state=s`),
    })
    expect(await run()).toBe(TEST_ACCESS_TOKEN)
    expect(keys(f)).toEqual([ROUTES.authorize, ROUTES.token])
  })
})

describe('refusals', () => {
  test.each([400, 401])('a rejected password (%i) is auth_failed naming user and password', async (status) => {
    const { f, run } = login({ [ROUTES.password]: () => rejectedPassword(status) })
    const err = await caught(run())
    expect(err).toMatchObject({
      name: 'ComfortCloudError',
      code: 'auth_failed',
      op: 'login',
      status,
      message: 'Comfort Cloud rejected the user name or password',
      suspectFields: ['user', 'password'],
    })
    expect(f.callsTo(ROUTES.callback)).toHaveLength(0)
    expect(secretsIn(err)).toEqual([])
  })

  test.each([
    ['an mfa_token input', mfaTokenForm],
    ['an Auth0 Guardian config', guardianPage],
  ])('%s means MFA is demanded: auth_failed, no callback', async (_label, page) => {
    const { f, run } = login({ [ROUTES.password]: () => page() })
    const err = await caught(run())
    expect(err).toMatchObject({ code: 'auth_failed', op: 'login' })
    expect(err.message).toContain('2FA')
    expect(err.suspectFields).toBeUndefined()
    expect(f.callsTo(ROUTES.callback)).toHaveLength(0)
    expect(secretsIn(err)).toEqual([])
  })

  test('a step-up MFA page behind a code-less final redirect is auth_failed', async () => {
    const { f, run } = login({
      [ROUTES.resume]: () => resumeRedirect(`/u/mfa-otp-challenge?state=${TEST_AUTH0_STATE}`),
      'GET /u/mfa-otp-challenge': () => mfaTokenForm(),
    })
    const err = await caught(run())
    expect(err).toMatchObject({ code: 'auth_failed', op: 'login' })
    expect(err.message).toContain('2FA')
    expect(f.callsTo(ROUTES.token)).toHaveLength(0)
  })
})

describe('unexpected answers', () => {
  const unexpected = async (overrides: Partial<Record<string, FakeRoute>>) => {
    const { f, run } = login(overrides)
    const err = await caught(run())
    expect(err).toMatchObject({ code: 'unexpected_response', op: 'login' })
    expect(secretsIn(err)).toEqual([])
    return { f, err }
  }

  test('the final redirect reaches the app without a code', async () => {
    await unexpected({ [ROUTES.resume]: () => resumeRedirect(`${REDIRECT_URI}?error=access_denied&state=s`) })
  })

  test('a code-less final redirect to a page without MFA', async () => {
    await unexpected({
      [ROUTES.resume]: () => resumeRedirect('/u/something-else'),
      'GET /u/something-else': () => new Response('<html><body>Hi</body></html>'),
    })
  })

  test('a redirect off the Panasonic login host is refused, not followed', async () => {
    const { f } = await unexpected({
      [ROUTES.authorize]: () => authorizeRedirect('https://evil.example.test/login?state=s'),
    })
    expect(keys(f)).toEqual([ROUTES.authorize])
  })

  test('a login page without the _csrf cookie', async () => {
    const { f } = await unexpected({ [ROUTES.loginPage]: () => new Response('<html></html>') })
    expect(f.callsTo(ROUTES.password)).toHaveLength(0)
  })

  test('a login redirect without a state', async () => {
    await unexpected({ [ROUTES.authorize]: () => authorizeRedirect('/login?client=x') })
  })

  test('a password answer without the callback form', async () => {
    await unexpected({ [ROUTES.password]: () => new Response('<html><body>Welcome</body></html>') })
  })

  test('authorize answering 200 instead of 302', async () => {
    const { err } = await unexpected({ [ROUTES.authorize]: () => new Response('ok') })
    expect(err.status).toBe(200)
  })

  test('a token answer that is not JSON, or has no access_token', async () => {
    await unexpected({ [ROUTES.token]: () => new Response('<html>no</html>') })
    await unexpected({ [ROUTES.token]: () => tokenReply('').clone() })
  })

  test('a refused code exchange', async () => {
    const { err } = await unexpected({ [ROUTES.token]: () => new Response('{}', { status: 400 }) })
    expect(err.status).toBe(400)
  })
})

describe('statuses and the network', () => {
  test('403 is forbidden and 429 rate_limited', async () => {
    for (const [status, code] of [
      [403, 'forbidden'],
      [429, 'rate_limited'],
    ] as const) {
      const { run } = login({ [ROUTES.password]: () => new Response(`nope ${TEST_USER}`, { status }) })
      const err = await caught(run())
      expect(err).toMatchObject({ code, op: 'login', status, message: `Comfort Cloud login failed: ${code} (HTTP ${status})` })
    }
  })

  test('503 is retried once, then unreachable', async () => {
    const { f, run } = login({ [ROUTES.authorize]: () => new Response(null, { status: 503 }) })
    expect(await caught(run())).toMatchObject({ code: 'unreachable', op: 'login', status: 503 })
    expect(f.callsTo(ROUTES.authorize)).toHaveLength(2)
  })

  test('a network failure is unreachable, carrying only the error name and code', async () => {
    const { run } = login({
      [ROUTES.password]: () => {
        throw Object.assign(new TypeError(`fetch failed for ${TEST_USER}:${TEST_PASSWORD}`), {
          cause: { code: 'ECONNRESET' },
        })
      },
    })
    const err = await caught(run())
    expect(err).toMatchObject({ code: 'unreachable', op: 'login' })
    expect(err.cause).toEqual({ name: 'TypeError', code: 'ECONNRESET' })
    expect(secretsIn(err)).toEqual([])
  })
})
```

Note on `tokenReply('')`: an empty `access_token` fails `min(1)`.

- [ ] **Step 2: Run them to verify they fail**

Run: `bunx vitest run src/lib/effects/comfortCloud/auth.test.ts`
Expected: FAIL — `Failed to resolve import "./auth"`.

- [ ] **Step 3: Implement `request.ts`**

`src/lib/effects/comfortCloud/request.ts`:
```ts
import { discard, fetchWithRetry, networkCause } from '../http'
import type { ComfortCloudCallStats } from './comfortCloud'
import { ComfortCloudError, type ComfortCloudOp } from './errors'

const TIMEOUT_MS = 10_000
const RETRY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504])
const RETRY_LIMIT = 1

export type SendOpts = { stats: ComfortCloudCallStats; signal?: AbortSignal }

/**
 * One request under ADR-0019's policy (10 s per attempt, 502/503/504 retried once). Redirects are
 * never followed (`redirect: 'manual'`): fetchWithRetry hands a 302 back unread with its Location
 * and Set-Cookie, and the Auth0 steps follow it themselves. A network failure, timeout or abort
 * becomes `unreachable` with only the error's name and code: its message may quote the URL or
 * the body (the password, a token).
 */
export async function send(
  fetch: typeof globalThis.fetch,
  op: ComfortCloudOp,
  url: string,
  init: RequestInit,
  o: SendOpts,
): Promise<Response> {
  try {
    return await fetchWithRetry(
      url,
      { ...init, redirect: 'manual' },
      {
        fetch,
        timeoutMs: TIMEOUT_MS,
        retryStatuses: RETRY_STATUSES,
        retryLimit: RETRY_LIMIT,
        signal: o.signal,
        stats: o.stats,
        onTiming: (ms) => {
          o.stats.fetchMs += ms
        },
      },
    )
  } catch (err) {
    throw new ComfortCloudError('unreachable', op, undefined, {
      cause: networkCause(err),
      message: `Comfort Cloud ${op} request failed or was cut off`,
    })
  }
}

/** The error for a status nobody asked for. 403/429/5xx by name; anything else is a changed API. */
export function errorForStatus(op: ComfortCloudOp, status: number): ComfortCloudError {
  if (status === 403) return new ComfortCloudError('forbidden', op, status)
  if (status === 429) return new ComfortCloudError('rate_limited', op, status)
  if (status >= 500) return new ComfortCloudError('unreachable', op, status)
  return new ComfortCloudError('unexpected_response', op, status)
}

/** `errorForStatus`, releasing the unread body first (never read into the message). */
export async function statusError(op: ComfortCloudOp, res: Response): Promise<ComfortCloudError> {
  await discard(res)
  return errorForStatus(op, res.status)
}
```

- [ ] **Step 4: Implement `auth.ts`**

`src/lib/effects/comfortCloud/auth.ts`:
```ts
import { createHash, randomInt } from 'node:crypto'
import { CookieJar } from 'tough-cookie'
import { discard } from '../http'
import type { ComfortCloudCallStats } from './comfortCloud'
import {
  APP_CLIENT_ID,
  AUDIENCE,
  AUTH_API_USER_AGENT,
  AUTH_BASE,
  AUTH_BROWSER_USER_AGENT,
  AUTH0_CLIENT,
  AUTH0_CONNECTION,
  AUTH0_TENANT,
  REDIRECT_URI,
  SCOPE,
} from './constants'
import { ComfortCloudError } from './errors'
import { hasGuardianConfig, hiddenInputs } from './html'
import { parseJson, parseToken } from './parse'
import { send, statusError } from './request'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** Upstream's `generate_random_string` (letters + digits), from a CSPRNG. */
export function randomString(length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)]
  return out
}

/** PKCE S256: base64url(SHA-256(verifier)), no padding (upstream's urlsafe_b64encode split on '='). */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'utf8').digest('base64url')
}

export type LoginDeps = {
  fetch: typeof globalThis.fetch
  user: string
  password: string
  stats: ComfortCloudCallStats
}

const unexpected = (message: string) =>
  new ComfortCloudError('unexpected_response', 'login', undefined, { message })

const rejected = (status: number) =>
  new ComfortCloudError('auth_failed', 'login', status, {
    message: 'Comfort Cloud rejected the user name or password',
    suspectFields: ['user', 'password'],
  })

const mfaDemanded = () =>
  new ComfortCloudError('auth_failed', 'login', undefined, {
    message:
      'Comfort Cloud demands a 2FA code for this account; the sync logs in with the password only',
  })

/** `location` resolved against the Auth0 host; any other origin is refused (never sent the jar). */
function onAuthHost(location: string): URL {
  let url: URL
  try {
    url = new URL(location, AUTH_BASE)
  } catch {
    throw unexpected('Comfort Cloud login redirect is not a URL')
  }
  if (url.origin !== AUTH_BASE) throw unexpected('Comfort Cloud login redirected off the Panasonic login host')
  return url
}

/** The `code` query parameter of a redirect target, or null. */
function codeOf(location: string): string | null {
  try {
    return new URL(location, AUTH_BASE).searchParams.get('code')
  } catch {
    return null
  }
}

/** A 302's Location (the body released); any other status is `statusError`. */
async function redirectTarget(res: Response): Promise<string> {
  if (res.status !== 302) throw await statusError('login', res)
  const location = res.headers.get('location')
  await discard(res)
  if (!location) throw unexpected('Comfort Cloud login redirect has no Location')
  return location
}

/** A page's HTML when it answered 200, else '' (the body released). */
async function pageHtml(res: Response): Promise<string> {
  if (res.status === 200) return res.text()
  await discard(res)
  return ''
}

const demandsMfa = (html: string) => hiddenInputs(html).has('mfa_token') || hasGuardianConfig(html)

/**
 * Steps 1–4 of the spec's login, a port of upstream 2026.8.9 `PanasonicAuthentication.authenticate`
 * (password path only): PKCE authorize → the Auth0 password form → its WS-Fed callback → the code
 * exchange. Returns the access token. A fresh cookie jar per login (upstream clears the domain
 * first). Never logs; the password and every token stay out of errors.
 */
export async function passwordLogin(d: LoginDeps): Promise<string> {
  const jar = new CookieJar()

  /** One request to the Auth0 host with the jar's cookies; its Set-Cookie goes back into the jar. */
  async function auth(url: URL, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers)
    const cookie = await jar.getCookieString(url.href)
    if (cookie) headers.set('cookie', cookie)
    const res = await send(d.fetch, 'login', url.href, { ...init, headers }, { stats: d.stats })
    for (const setCookie of res.headers.getSetCookie()) {
      await jar.setCookie(setCookie, url.href, { ignoreError: true })
    }
    return res
  }
  const browserGet = (url: URL) => auth(url, { headers: { 'user-agent': AUTH_BROWSER_USER_AGENT } })

  /** Steps 2–3: the password form, its callback and the resumed authorize → the code. */
  async function passwordForm(loginLocation: string): Promise<string> {
    const loginUrl = onAuthHost(loginLocation)
    const state = loginUrl.searchParams.get('state')
    if (!state) throw unexpected('Comfort Cloud login redirect carries no state')
    const page = await browserGet(loginUrl)
    if (page.status !== 200) throw await statusError('login', page)

    const passwordUrl = new URL('/usernamepassword/login', AUTH_BASE)
    const csrf = (await jar.getCookies(passwordUrl.href)).find((c) => c.key === '_csrf')?.value
    if (!csrf) throw unexpected('Comfort Cloud login page set no _csrf cookie')
    const answer = await auth(passwordUrl, {
      method: 'POST',
      headers: {
        'auth0-client': AUTH0_CLIENT,
        'user-agent': AUTH_API_USER_AGENT,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        client_id: APP_CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        tenant: AUTH0_TENANT,
        response_type: 'code',
        scope: SCOPE,
        audience: AUDIENCE,
        _csrf: csrf,
        state,
        _intstate: 'deprecated',
        username: d.user,
        password: d.password,
        lang: 'en',
        connection: AUTH0_CONNECTION,
      }),
    })
    if (answer.status === 400 || answer.status === 401) {
      await discard(answer)
      throw rejected(answer.status)
    }
    if (answer.status !== 200) throw await statusError('login', answer)
    const html = await answer.text()
    if (demandsMfa(html)) throw mfaDemanded()
    const fields = hiddenInputs(html)
    if (!fields.has('wa') || !fields.has('wresult') || !fields.has('wctx')) {
      throw unexpected('Comfort Cloud login answer has no callback form')
    }

    const callback = await auth(new URL('/login/callback', AUTH_BASE), {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': AUTH_BROWSER_USER_AGENT,
      },
      body: new URLSearchParams([...fields]),
    })
    const resumed = await browserGet(onAuthHost(await redirectTarget(callback)))
    const final = await redirectTarget(resumed)
    const code = codeOf(final)
    if (code) return code
    if (final.startsWith(REDIRECT_URI)) {
      throw unexpected('Comfort Cloud login ended at the app without an authorization code')
    }
    // Upstream: some Auth0 setups surface a step-up MFA page only here.
    if (demandsMfa(await pageHtml(await browserGet(onAuthHost(final))))) throw mfaDemanded()
    throw unexpected('Comfort Cloud login did not produce an authorization code')
  }

  // Step 1: authorize with a PKCE challenge.
  const verifier = randomString(43)
  const authorize = new URL('/authorize', AUTH_BASE)
  const params = {
    scope: SCOPE,
    audience: AUDIENCE,
    protocol: 'oauth2',
    response_type: 'code',
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: 'S256',
    auth0Client: AUTH0_CLIENT,
    client_id: APP_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    state: randomString(20),
  }
  for (const [key, value] of Object.entries(params)) authorize.searchParams.set(key, value)
  const location = await redirectTarget(
    await auth(authorize, { headers: { 'user-agent': AUTH_API_USER_AGENT } }),
  )

  // Auth0 may already know the session and send the app its code straight away.
  let code: string
  if (location.startsWith(REDIRECT_URI)) {
    const direct = codeOf(location)
    if (!direct) throw unexpected('Comfort Cloud authorize reached the app without an authorization code')
    code = direct
  } else {
    code = await passwordForm(location)
  }

  // Step 4: the code exchange.
  const tokenRes = await auth(new URL('/oauth/token', AUTH_BASE), {
    method: 'POST',
    headers: {
      'auth0-client': AUTH0_CLIENT,
      'user-agent': AUTH_API_USER_AGENT,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      scope: 'openid',
      client_id: APP_CLIENT_ID,
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  })
  if (tokenRes.status !== 200) throw await statusError('login', tokenRes)
  return parseToken(parseJson('login', await tokenRes.text()))
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bunx vitest run src/lib/effects/comfortCloud/auth.test.ts`
Expected: PASS. If the cookie tests fail, check that `fakeFetch` received the `cookie` header (Node's `Request`
keeps it) before touching the jar logic.

- [ ] **Step 6: Commit**

```bash
bun run check
git add src/lib/effects/comfortCloud/request.ts src/lib/effects/comfortCloud/auth.ts \
  src/lib/effects/comfortCloud/auth.test.ts
git commit -m "feat(heat-pumps): port the Comfort Cloud password login

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The client (`createComfortCloudClient`)

**Reviewers:** `code-reviewer` + `test-completeness`. `code-reviewer` diffs the retry rules against upstream's
`panasonicsession.py` `execute_post` / `execute_get` and `helpers.has_new_version_been_published`;
`test-completeness` checks every `ComfortCloudError` code the client can throw (`auth_failed`, `forbidden`,
`rate_limited`, `unreachable`, `unexpected_response`) has a test per op where reachable.

**Files:**
- Create: `src/lib/effects/comfortCloud/client.ts`, `src/lib/effects/comfortCloud/index.ts`
- Test: `src/lib/effects/comfortCloud/comfortCloud.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces:
  - `createComfortCloudClient(deps: { fetch: typeof globalThis.fetch; user: string; password: string; now?: () => Date }): ComfortCloudClient`
  - `index.ts` barrel: `createComfortCloudClient`, `newCallStats`, the types, `ComfortCloudError`,
    `ComfortCloudOp`, `ComfortCloudCredentialField`. **Not** added to `src/lib/effects/index.ts` (1b).

- [ ] **Step 1: Write the failing tests**

`src/lib/effects/comfortCloud/comfortCloud.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { type FakeRoute, fakeFetch } from '../testing/fakeFetch'
import { createComfortCloudClient, newCallStats } from '.'
import { PINNED_APP_VERSION } from './constants'
import type { ComfortCloudError } from './errors'
import {
  accLoginReply,
  apiError,
  authRoutes,
  dayHistoryReply,
  deviceGroupReply,
  MATSAL_GUID,
  MODEL,
  monthHistoryReply,
  OVERVANING_GUID,
  playStorePage,
  ROUTES,
  rejectedPassword,
  secretsIn,
  TEST_ACCESS_TOKEN,
  TEST_ACCESS_TOKEN_2,
  TEST_CLIENT_ID,
  TEST_PASSWORD,
  TEST_USER,
} from './fixtures'
import { cfcApiKey } from './headers'

const NOW = new Date('2026-06-11T08:00:00.123Z')
const HOUR = 3_600_000
beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
  vi.setTimerTickMode('nextTimerAsync')
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const bearer = (req: Request) => req.headers.get('x-user-authorization-v2')
const version = (req: Request) => req.headers.get('x-app-version')
const historyBody = async (req: Request) =>
  (await req.clone().json()) as { deviceGuid: string; dataMode: number; date: string; osTimezone: string }

/** A fake Comfort Cloud: Auth0 hands out TEST_ACCESS_TOKEN, then TEST_ACCESS_TOKEN_2. */
function server(overrides: Partial<Record<string, FakeRoute>> = {}) {
  const routes: Record<string, FakeRoute> = {
    ...authRoutes(),
    [ROUTES.accLogin]: () => accLoginReply(),
    [ROUTES.group]: () => deviceGroupReply(),
    [ROUTES.history]: async (req) => {
      const { dataMode, date } = await historyBody(req)
      return dataMode === 2
        ? monthHistoryReply(`${date.slice(0, 4)}-${date.slice(4, 6)}`)
        : dayHistoryReply(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`)
    },
    [ROUTES.playStore]: () => playStorePage('4.5.0'),
  }
  for (const [key, route] of Object.entries(overrides)) if (route) routes[key] = route
  const f = fakeFetch(routes)
  const client = createComfortCloudClient({ fetch: f.fetch, user: TEST_USER, password: TEST_PASSWORD })
  return { f, client }
}
const caught = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('expected a rejection')
    },
    (e: unknown) => e as ComfortCloudError,
  )
const apiKeyNow = (token: string) => cfcApiKey('2026-06-11 08:00:00', token)
const clean = (err: unknown) =>
  expect(secretsIn(err, [apiKeyNow(TEST_ACCESS_TOKEN), apiKeyNow(TEST_ACCESS_TOKEN_2)])).toEqual([])

describe('session', () => {
  test('logs in lazily, once, and reuses the session', async () => {
    const { f, client } = server()
    expect(f.calls).toHaveLength(0)
    const stats = newCallStats()
    await client.units({ stats })
    await client.dayHours(MATSAL_GUID, '2026-06-10', { stats })
    expect(f.callsTo(ROUTES.authorize)).toHaveLength(1)
    expect(f.callsTo(ROUTES.accLogin)).toHaveLength(1)
    expect(stats).toMatchObject({ logins: 1, requests: 6 + 1 + 1 + 1, retries: 0 })
  })

  test('the session login has no client id; every later call carries the full header set', async () => {
    const { f, client } = server()
    await client.units()
    const login = f.callsTo(ROUTES.accLogin)[0]
    expect(await login.clone().json()).toEqual({ language: 0 })
    expect(login.headers.get('x-client-id')).toBeNull()
    expect(bearer(login)).toBe(`Bearer ${TEST_ACCESS_TOKEN}`)
    const group = f.callsTo(ROUTES.group)[0]
    expect(Object.fromEntries(group.headers)).toMatchObject({
      'user-agent': 'G-RAC',
      'x-app-name': 'Comfort Cloud',
      'x-app-type': '1',
      'x-app-version': PINNED_APP_VERSION,
      'x-app-timestamp': '2026-06-11 08:00:00',
      'x-cfc-api-key': apiKeyNow(TEST_ACCESS_TOKEN),
      'x-user-authorization-v2': `Bearer ${TEST_ACCESS_TOKEN}`,
      'x-client-id': TEST_CLIENT_ID,
    })
  })

  test('concurrent first calls share one login', async () => {
    const { f, client } = server()
    await Promise.all([
      client.units(),
      client.dayHours(MATSAL_GUID, '2026-06-10'),
      client.monthDays(OVERVANING_GUID, '2026-06'),
    ])
    expect(f.callsTo(ROUTES.authorize)).toHaveLength(1)
    expect(f.callsTo(ROUTES.accLogin)).toHaveLength(1)
  })

  test('a token 23 h old is replaced before the call; 22 h 59 min is still used', async () => {
    const { f, client } = server()
    await client.units()
    vi.setSystemTime(NOW.getTime() + 23 * HOUR - 60_000)
    await client.units()
    expect(f.callsTo(ROUTES.authorize)).toHaveLength(1)
    vi.setSystemTime(NOW.getTime() + 23 * HOUR)
    await client.units()
    expect(f.callsTo(ROUTES.authorize)).toHaveLength(2)
    expect(bearer(f.callsTo(ROUTES.group)[2])).toBe(`Bearer ${TEST_ACCESS_TOKEN_2}`)
  })

  test('401 without 4106: one fresh login, the call retried with the new token', async () => {
    const { f, client } = server({
      [ROUTES.group]: (req) =>
        bearer(req) === `Bearer ${TEST_ACCESS_TOKEN}` ? apiError(401, 4100) : deviceGroupReply(),
    })
    const stats = newCallStats()
    expect(await client.units({ stats })).toHaveLength(2)
    expect(stats.logins).toBe(2)
    expect(f.callsTo(ROUTES.group).map(bearer)).toEqual([
      `Bearer ${TEST_ACCESS_TOKEN}`,
      `Bearer ${TEST_ACCESS_TOKEN_2}`,
    ])
  })

  test('401 again right after the fresh login is auth_failed', async () => {
    const { f, client } = server({ [ROUTES.group]: () => apiError(401, 4100) })
    const err = await caught(client.units())
    expect(err).toMatchObject({ code: 'auth_failed', op: 'units', status: 401 })
    expect(f.callsTo(ROUTES.authorize)).toHaveLength(2)
    clean(err)
  })

  test('a refused login blocks new logins for five minutes', async () => {
    const { f, client } = server({ [ROUTES.password]: () => rejectedPassword() })
    const first = await caught(client.units())
    expect(first).toMatchObject({ code: 'auth_failed', op: 'login', suspectFields: ['user', 'password'] })
    vi.setSystemTime(NOW.getTime() + 5 * 60_000 - 1)
    expect(await caught(client.dayHours(MATSAL_GUID, '2026-06-10'))).toBe(first)
    expect(f.callsTo(ROUTES.authorize)).toHaveLength(1)
    vi.setSystemTime(NOW.getTime() + 5 * 60_000)
    await caught(client.units())
    expect(f.callsTo(ROUTES.authorize)).toHaveLength(2)
    clean(first)
  })
})

describe('app version', () => {
  const outdatedOnPinned: FakeRoute = (req) =>
    version(req) === PINNED_APP_VERSION ? apiError(401, 4106) : deviceGroupReply()

  test('401 + 4106: the Play Store version is looked up, the call retried, the version kept', async () => {
    const { f, client } = server({ [ROUTES.group]: outdatedOnPinned })
    expect(await client.units()).toHaveLength(2)
    expect(f.callsTo(ROUTES.group).map(version)).toEqual([PINNED_APP_VERSION, '4.5.0'])
    await client.dayHours(MATSAL_GUID, '2026-06-10')
    expect(version(f.callsTo(ROUTES.history)[0])).toBe('4.5.0')
    expect(f.callsTo(ROUTES.playStore)).toHaveLength(1)
    expect(f.callsTo(ROUTES.authorize)).toHaveLength(1) // 4106 is not a token problem
  })

  test('401 + 4106 on the session login is handled the same way', async () => {
    const { f, client } = server({
      [ROUTES.accLogin]: (req) => (version(req) === PINNED_APP_VERSION ? apiError(401, 4106) : accLoginReply()),
    })
    await client.units()
    expect(f.callsTo(ROUTES.accLogin).map(version)).toEqual([PINNED_APP_VERSION, '4.5.0'])
    expect(version(f.callsTo(ROUTES.group)[0])).toBe('4.5.0')
  })

  test('a failed lookup is unexpected_response and the call is not retried', async () => {
    for (const page of [
      () => new Response('<html>no version here</html>'),
      () => new Response(null, { status: 404 }),
      () => {
        throw new TypeError('fetch failed')
      },
    ]) {
      const { f, client } = server({ [ROUTES.group]: outdatedOnPinned, [ROUTES.playStore]: page })
      const err = await caught(client.units())
      expect(err).toMatchObject({ code: 'unexpected_response', op: 'units' })
      expect(err.message).toContain('Play Store')
      expect(f.callsTo(ROUTES.group)).toHaveLength(1)
    }
  })

  test('still 4106 after the lookup is unexpected_response, not a loop', async () => {
    const { f, client } = server({ [ROUTES.group]: () => apiError(401, 4106) })
    expect(await caught(client.units())).toMatchObject({ code: 'unexpected_response', op: 'units' })
    expect(f.callsTo(ROUTES.group)).toHaveLength(2)
    expect(f.callsTo(ROUTES.playStore)).toHaveLength(1)
  })
})

describe('calls', () => {
  test('units: the two air conditioners', async () => {
    const { client } = server()
    expect(await client.units()).toEqual([
      { guid: MATSAL_GUID, name: 'Matsal', model: MODEL },
      { guid: OVERVANING_GUID, name: 'Övervåning', model: MODEL },
    ])
  })

  test('dayHours: mode 0, the raw guid, the compact day, osTimezone +00:00', async () => {
    const { f, client } = server({
      [ROUTES.history]: () => dayHistoryReply('2026-06-10', { filledHours: 10 }),
    })
    const h = await client.dayHours(MATSAL_GUID, '2026-06-10')
    expect(await historyBody(f.callsTo(ROUTES.history)[0])).toEqual({
      deviceGuid: MATSAL_GUID,
      dataMode: 0,
      date: '20260610',
      osTimezone: '+00:00',
    })
    expect(h.registeredOn).toBe('2024-10-31')
    expect(h.rows).toHaveLength(10)
    expect(h.rows[9].hourStart).toEqual(new Date('2026-06-10T09:00:00Z'))
  })

  test('monthDays: mode 2 on the first of the month', async () => {
    const { f, client } = server({
      [ROUTES.history]: () => monthHistoryReply('2026-06', { filledDays: 11 }),
    })
    const h = await client.monthDays(OVERVANING_GUID, '2026-06')
    expect(await historyBody(f.callsTo(ROUTES.history)[0])).toEqual({
      deviceGuid: OVERVANING_GUID,
      dataMode: 2,
      date: '20260601',
      osTimezone: '+00:00',
    })
    expect(h.rows.map((r) => r.day).at(-1)).toBe('2026-06-11')
  })

  test('a bad day, month or guid is a RangeError before any request', async () => {
    const { f, client } = server()
    await expect(client.dayHours(MATSAL_GUID, '2026-02-30')).rejects.toThrow(RangeError)
    await expect(client.dayHours(MATSAL_GUID, '20260610')).rejects.toThrow(RangeError)
    await expect(client.monthDays(MATSAL_GUID, '2026-13')).rejects.toThrow(RangeError)
    await expect(client.dayHours('', '2026-06-10')).rejects.toThrow(RangeError)
    await expect(client.dayHours('x'.repeat(129), '2026-06-10')).rejects.toThrow(RangeError)
    expect(f.calls).toHaveLength(0)
  })

  test('an answer for another day fails the call (never stored under wrong hours)', async () => {
    const { client } = server({ [ROUTES.history]: () => dayHistoryReply('2026-06-11') })
    expect(await caught(client.dayHours(MATSAL_GUID, '2026-06-10'))).toMatchObject({
      code: 'unexpected_response',
      op: 'history',
    })
  })
})

describe('errors', () => {
  test.each([
    [403, 'forbidden'],
    [429, 'rate_limited'],
    [500, 'unreachable'],
    [404, 'unexpected_response'],
    [400, 'unexpected_response'],
  ] as const)('history HTTP %i is %s', async (status, code) => {
    const { client } = server({ [ROUTES.history]: () => new Response(`{"echo":"${TEST_USER}"}`, { status }) })
    const err = await caught(client.dayHours(MATSAL_GUID, '2026-06-10'))
    expect(err).toMatchObject({ code, op: 'history', status })
    clean(err)
  })

  test('503 is retried once, then unreachable', async () => {
    const { f, client } = server({ [ROUTES.group]: () => new Response(null, { status: 503 }) })
    expect(await caught(client.units())).toMatchObject({ code: 'unreachable', op: 'units', status: 503 })
    expect(f.callsTo(ROUTES.group)).toHaveLength(2)
  })

  test.each([401, 400])('code 4103 (terms to accept, HTTP %i) is unexpected_response without a re-login', async (status) => {
    const { f, client } = server({ [ROUTES.group]: () => apiError(status, 4103) })
    const err = await caught(client.units())
    expect(err).toMatchObject({ code: 'unexpected_response', op: 'units' })
    expect(err.message).toContain('4103')
    expect(f.callsTo(ROUTES.authorize)).toHaveLength(1)
  })

  test('a 200 that is not JSON is unexpected_response', async () => {
    const { client } = server({ [ROUTES.group]: () => new Response('<html>maintenance</html>') })
    expect(await caught(client.units())).toMatchObject({ code: 'unexpected_response', op: 'units' })
  })

  test('a network failure is unreachable with only name and code', async () => {
    const { client } = server({
      [ROUTES.history]: () => {
        throw Object.assign(new TypeError(`fetch failed Bearer ${TEST_ACCESS_TOKEN} ${MATSAL_GUID}`), {
          cause: { code: 'ETIMEDOUT' },
        })
      },
    })
    const err = await caught(client.dayHours(MATSAL_GUID, '2026-06-10'))
    expect(err).toMatchObject({ code: 'unreachable', op: 'history' })
    expect(err.cause).toEqual({ name: 'TypeError', code: 'ETIMEDOUT' })
    clean(err)
  })

  test('an already-aborted signal fails unreachable before any request', async () => {
    const { f, client } = server()
    const ac = new AbortController()
    ac.abort()
    expect(await caught(client.units({ signal: ac.signal }))).toMatchObject({ code: 'unreachable', op: 'units' })
    expect(f.calls).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bunx vitest run src/lib/effects/comfortCloud/comfortCloud.test.ts`
Expected: FAIL — `Failed to resolve import "."` (no `index.ts`).

- [ ] **Step 3: Implement `client.ts` and the barrel**

`src/lib/effects/comfortCloud/client.ts`:
```ts
import { isUtcDay, isUtcMonth } from '~/lib/time/utc'
import { discard, networkCause } from '../http'
import { passwordLogin } from './auth'
import {
  type ComfortCloudCallOpts,
  type ComfortCloudCallStats,
  type ComfortCloudClient,
  newCallStats,
} from './comfortCloud'
import {
  ACC_BASE,
  AUTH_BROWSER_USER_AGENT,
  DATA_MODE_DAY,
  DATA_MODE_MONTH,
  OS_TIMEZONE,
  PINNED_APP_VERSION,
  PLAY_STORE_URL,
  PLAY_STORE_VERSION_RE,
} from './constants'
import { ComfortCloudError, type ComfortCloudOp } from './errors'
import { apiHeaders } from './headers'
import { parseAccLogin, parseDayHistory, parseJson, parseMonthHistory, parseUnits } from './parse'
import { errorForStatus, type SendOpts, send } from './request'

/** The token lasts 24 h; log in again an hour early (spec). The refresh token is never used. */
const TOKEN_MAX_AGE_MS = 23 * 3_600_000
/** A refused login blocks new attempts this long: a wrong password must not trip Auth0's lockout. */
const AUTH_FAILURE_TTL_MS = 5 * 60_000
const MAX_GUID_LENGTH = 128

type Session = { token: string; clientId: string; issuedAt: number }
type Auth = { token: string; clientId?: string }
/** An API answer with its body read ('' for a body-less copy after exhausted retries). */
type Answer = { status: number; text: string }

/** 401 whose body names 4106: a newer app version is published (upstream's helpers.py). */
const isOutdatedApp = (a: Answer) => a.status === 401 && a.text.includes('4106')
/** 4103: updated terms wait for acceptance in the app (upstream's AgreementNotAcceptedError). */
const isTermsPending = (a: Answer) => a.text.includes('4103')

/**
 * Real Comfort Cloud client (ADR-0027). Logs in lazily with the password (`passwordLogin`, then
 * the `/auth/v2/login` session), keeps the token only in this closure, and shares one in-flight
 * login among concurrent callers. Never logs.
 */
export function createComfortCloudClient(deps: {
  fetch: typeof globalThis.fetch
  user: string
  password: string
  now?: () => Date
}): ComfortCloudClient {
  const now = deps.now ?? (() => new Date())
  let session: Session | null = null
  let pending: Promise<Session> | null = null
  let appVersion = PINNED_APP_VERSION
  let loginBlock: { error: ComfortCloudError; until: number } | null = null

  async function call(
    op: ComfortCloudOp,
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    auth: Auth,
    o: SendOpts,
  ): Promise<Answer> {
    const res = await send(
      deps.fetch,
      op,
      `${ACC_BASE}${path}`,
      {
        method,
        headers: apiHeaders({ now: now(), token: auth.token, clientId: auth.clientId, appVersion }),
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      o,
    )
    return { status: res.status, text: await res.text() }
  }

  async function refreshAppVersion(op: ComfortCloudOp, stats: ComfortCloudCallStats) {
    const failed = new ComfortCloudError('unexpected_response', op, undefined, {
      message: 'Comfort Cloud wants a newer app version and the Play Store lookup failed',
    })
    let res: Response
    try {
      res = await send(
        deps.fetch,
        op,
        PLAY_STORE_URL,
        { headers: { 'user-agent': AUTH_BROWSER_USER_AGENT } },
        { stats },
      )
    } catch {
      throw failed
    }
    if (!res.ok) {
      await discard(res)
      throw failed
    }
    const match = PLAY_STORE_VERSION_RE.exec(await res.text())
    if (!match) throw failed
    appVersion = match[1]
  }

  /** One API call; on 401 + 4106 the app version is looked up once and the call retried once. */
  async function apiCall(
    op: ComfortCloudOp,
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    auth: Auth,
    o: SendOpts,
  ): Promise<Answer> {
    const answer = await call(op, method, path, body, auth, o)
    if (!isOutdatedApp(answer)) return answer
    await refreshAppVersion(op, o.stats)
    const retried = await call(op, method, path, body, auth, o)
    if (isOutdatedApp(retried)) {
      throw new ComfortCloudError('unexpected_response', op, 401, {
        message: `Comfort Cloud still asks for a newer app version after the lookup (${appVersion})`,
      })
    }
    return retried
  }

  /** A non-200 answer as an error; the body is only searched for codes, never quoted. */
  function answerError(op: ComfortCloudOp, a: Answer): ComfortCloudError {
    if (isTermsPending(a)) {
      return new ComfortCloudError('unexpected_response', op, a.status, {
        message: 'Comfort Cloud asks to accept updated terms in the app (code 4103)',
      })
    }
    if (a.status === 401) {
      return new ComfortCloudError('auth_failed', op, 401, {
        message: `Comfort Cloud refused the token on ${op}`,
      })
    }
    return errorForStatus(op, a.status)
  }

  async function logIn(stats: ComfortCloudCallStats): Promise<Session> {
    if (loginBlock !== null && now().getTime() < loginBlock.until) throw loginBlock.error
    stats.logins++
    try {
      const issuedAt = now().getTime()
      const token = await passwordLogin({ fetch: deps.fetch, user: deps.user, password: deps.password, stats })
      const answer = await apiCall('login', 'POST', '/auth/v2/login', { language: 0 }, { token }, { stats })
      if (answer.status !== 200) throw answerError('login', answer)
      const clientId = parseAccLogin(parseJson('login', answer.text))
      loginBlock = null
      return { token, clientId, issuedAt }
    } catch (err) {
      if (err instanceof ComfortCloudError && err.code === 'auth_failed') {
        loginBlock = { error: err, until: now().getTime() + AUTH_FAILURE_TTL_MS }
      }
      throw err
    }
  }

  /**
   * The live session, or the shared login. A session that is `stale` (the caller saw it refused)
   * or 23 h old is dropped first; one that another caller already replaced is reused.
   */
  function sessionFor(stats: ComfortCloudCallStats, stale?: Session): Promise<Session> {
    if (session !== null && (session === stale || now().getTime() - session.issuedAt >= TOKEN_MAX_AGE_MS)) {
      session = null
    }
    if (session !== null) return Promise.resolve(session)
    if (pending === null) {
      const shared = logIn(stats)
        .then((s) => {
          session = s
          return s
        })
        .finally(() => {
          pending = null
        })
      // Every waiter may have gone: the shared rejection must never go unhandled.
      shared.catch(() => {})
      pending = shared
    }
    return pending
  }

  /** An authenticated call: one fresh login and one retry on a 401 that isn't 4106 or 4103. */
  async function authed(
    op: ComfortCloudOp,
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    o: ComfortCloudCallOpts = {},
  ): Promise<unknown> {
    if (o.signal?.aborted) {
      throw new ComfortCloudError('unreachable', op, undefined, {
        cause: networkCause(o.signal.reason),
        message: `Comfort Cloud ${op} call was cut off before it started`,
      })
    }
    const sendOpts: SendOpts = { stats: o.stats ?? newCallStats(), signal: o.signal }
    let s = await sessionFor(sendOpts.stats)
    let answer = await apiCall(op, method, path, body, s, sendOpts)
    if (answer.status === 401 && !isTermsPending(answer)) {
      s = await sessionFor(sendOpts.stats, s)
      answer = await apiCall(op, method, path, body, s, sendOpts)
      if (answer.status === 401 && !isTermsPending(answer)) {
        throw new ComfortCloudError('auth_failed', op, 401, {
          message: `Comfort Cloud refused the ${op} call right after a fresh login`,
        })
      }
    }
    if (answer.status !== 200) throw answerError(op, answer)
    return parseJson(op, answer.text)
  }

  function checkGuid(guid: string) {
    if (guid.length === 0 || guid.length > MAX_GUID_LENGTH) {
      throw new RangeError(`Comfort Cloud device guid must be 1–${MAX_GUID_LENGTH} characters`)
    }
  }

  return {
    async units(o) {
      return parseUnits(await authed('units', 'GET', '/device/group', undefined, o))
    },

    async dayHours(guid, utcDay, o) {
      checkGuid(guid)
      if (!isUtcDay(utcDay)) throw new RangeError(`Comfort Cloud day must be a YYYY-MM-DD UTC day, got ${utcDay}`)
      const body = {
        deviceGuid: guid,
        dataMode: DATA_MODE_DAY,
        date: utcDay.replaceAll('-', ''),
        osTimezone: OS_TIMEZONE,
      }
      return parseDayHistory(utcDay, await authed('history', 'POST', '/deviceHistoryData', body, o))
    },

    async monthDays(guid, utcMonth, o) {
      checkGuid(guid)
      if (!isUtcMonth(utcMonth)) throw new RangeError(`Comfort Cloud month must be YYYY-MM, got ${utcMonth}`)
      const body = {
        deviceGuid: guid,
        dataMode: DATA_MODE_MONTH,
        date: `${utcMonth.replace('-', '')}01`,
        osTimezone: OS_TIMEZONE,
      }
      return parseMonthHistory(utcMonth, await authed('history', 'POST', '/deviceHistoryData', body, o))
    },
  }
}
```

`src/lib/effects/comfortCloud/index.ts`:
```ts
// Step 1a: the client only. Step 1b adds the `comfortCloud` facade and registers it in
// src/lib/effects/index.ts.
export { createComfortCloudClient } from './client'
export {
  type ComfortCloudCallOpts,
  type ComfortCloudCallStats,
  type ComfortCloudClient,
  type ComfortCloudDay,
  type ComfortCloudHistory,
  type ComfortCloudHour,
  type ComfortCloudUnit,
  newCallStats,
} from './comfortCloud'
export { type ComfortCloudCredentialField, ComfortCloudError, type ComfortCloudOp } from './errors'
```

- [ ] **Step 4: Run the tests to verify they pass, and that nothing logs**

```bash
bunx vitest run src/lib/effects/comfortCloud/
grep -rn "logger\|console\." src/lib/effects/comfortCloud/ --include=*.ts | grep -v "\.test\.ts" || echo "no logging"
grep -n "comfortCloud" src/lib/effects/index.ts || echo "not registered (1b)"
```
Expected: all comfortCloud tests PASS; `no logging`; `not registered (1b)`.

- [ ] **Step 5: Commit**

```bash
bun run check
git add src/lib/effects/comfortCloud/client.ts src/lib/effects/comfortCloud/index.ts \
  src/lib/effects/comfortCloud/comfortCloud.test.ts
git commit -m "feat(heat-pumps): add the Comfort Cloud client

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The `heat_pump` and `heat_pump_reading` tables + migration

**Reviewers:** the schema gate is Task 6 (`migration-guard` + the schema-design reviewer); dispatch it as soon as
this commit lands, before Task 7 starts.

**Files:**
- Create: `src/lib/db/schema/heatPump.ts`, `src/lib/db/heatPumpSchema.test.ts`
- Modify: `src/lib/db/schema/index.ts`
- Generate: `drizzle/0022_heat_pump.sql`, `drizzle/meta/0022_snapshot.json`, `drizzle/meta/_journal.json`

**Interfaces:**
- Produces: `heatPump`, `heatPumpReading` (Drizzle tables), `HEAT_PUMP_HOUR_KWH_MAX = 5`,
  `HEAT_PUMP_TEMP_MIN_C = -60`, `HEAT_PUMP_TEMP_MAX_C = 60`; constraint names `heat_pump_guid_unique`,
  `heat_pump_reading_pkey`, `heat_pump_reading_heat_pump_id_heat_pump_id_fk`, `heat_pump_reading_hour_aligned_check`,
  `heat_pump_reading_energy_kwh_check`, `heat_pump_reading_{heat_share,cool_share,setpoint_c,inside_c,outside_c}_check`.

- [ ] **Step 1: Write the failing schema test** (it lives in `src/lib/db/`, not `schema/`: drizzle-kit scans the
  barrel only, but keep the house convention from `houseEnergySchema.test.ts`)

`src/lib/db/heatPumpSchema.test.ts`:
```ts
import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import {
  HEAT_PUMP_HOUR_KWH_MAX,
  HEAT_PUMP_TEMP_MAX_C,
  HEAT_PUMP_TEMP_MIN_C,
  heatPump,
  heatPumpReading,
} from '~/lib/db/schema'
import { expectConstraintViolation } from '~test/expectConstraintViolation'
import { setupDatabase } from '~test/setup'

// Lives in src/lib/db/ (not schema/), like houseEnergySchema.test.ts.
setupDatabase()

type Reading = typeof heatPumpReading.$inferInsert
const NOW = new Date('2026-10-08T10:00:00Z')

async function unit(guid = 'CS-HZ25ZKE+0000000001') {
  const [row] = await db
    .insert(heatPump)
    .values({ guid, name: 'Matsal', model: 'CS-HZ25ZKE', firstSeenAt: NOW, lastSeenAt: NOW })
    .returning()
  return row
}

// Synthetic values only (public repo).
const reading = (heatPumpId: string, overrides: Partial<Reading> = {}): Reading => ({
  heatPumpId,
  hourStart: new Date('2026-10-07T10:00:00Z'),
  energyKwh: 0.12,
  heatShare: 1,
  coolShare: 0,
  setpointC: 21,
  insideC: 20.5,
  outsideC: 3.25,
  ...overrides,
})

test('a unit is unique by guid; its dates start empty', async () => {
  const u = await unit()
  expect(u).toMatchObject({ registeredOn: null, historyCompleteAt: null, firstSeenAt: NOW, lastSeenAt: NOW })
  await expectConstraintViolation(unit(), 'heat_pump_guid_unique')
})

test('a reading is keyed by unit and hour; two units share an hour', async () => {
  const a = await unit()
  const b = await unit('CS-HZ25ZKE+0000000002')
  await db.insert(heatPumpReading).values([reading(a.id), reading(b.id)])
  await expectConstraintViolation(db.insert(heatPumpReading).values(reading(a.id)), 'heat_pump_reading_pkey')
})

test('a reading must start on a whole UTC hour', async () => {
  const u = await unit()
  for (const hourStart of [
    new Date('2026-10-07T10:30:00Z'),
    new Date('2026-10-07T10:00:01Z'),
    new Date('2026-10-07T10:00:00.001Z'),
  ]) {
    await expectConstraintViolation(
      db.insert(heatPumpReading).values(reading(u.id, { hourStart })),
      'heat_pump_reading_hour_aligned_check',
    )
  }
  await db.insert(heatPumpReading).values(reading(u.id, { hourStart: new Date('2026-10-07T23:00:00Z') }))
})

test('energy is 0 or more and under 5 kWh', async () => {
  const u = await unit()
  for (const energyKwh of [-0.001, HEAT_PUMP_HOUR_KWH_MAX]) {
    await expectConstraintViolation(
      db.insert(heatPumpReading).values(reading(u.id, { energyKwh })),
      'heat_pump_reading_energy_kwh_check',
    )
  }
  await db.insert(heatPumpReading).values(reading(u.id, { energyKwh: 0 }))
  await db.insert(heatPumpReading).values(
    reading(u.id, { energyKwh: 4.999, hourStart: new Date('2026-10-07T11:00:00Z') }),
  )
})

test.each([
  ['heatShare', 'heat_pump_reading_heat_share_check', -0.01, 1.01],
  ['coolShare', 'heat_pump_reading_cool_share_check', -0.01, 1.01],
  ['setpointC', 'heat_pump_reading_setpoint_c_check', HEAT_PUMP_TEMP_MIN_C - 0.25, HEAT_PUMP_TEMP_MAX_C + 0.25],
  ['insideC', 'heat_pump_reading_inside_c_check', HEAT_PUMP_TEMP_MIN_C - 0.25, HEAT_PUMP_TEMP_MAX_C + 0.25],
  ['outsideC', 'heat_pump_reading_outside_c_check', HEAT_PUMP_TEMP_MIN_C - 0.25, HEAT_PUMP_TEMP_MAX_C + 0.25],
] as const)('%s outside its range is rejected; its bounds and null are not', async (field, constraint, low, high) => {
  const u = await unit()
  for (const value of [low, high]) {
    await expectConstraintViolation(
      db.insert(heatPumpReading).values(reading(u.id, { [field]: value } as Partial<Reading>)),
      constraint,
    )
  }
  const bounds = field.endsWith('Share') ? [0, 1] : [HEAT_PUMP_TEMP_MIN_C, HEAT_PUMP_TEMP_MAX_C]
  for (const [i, value] of [...bounds, null].entries()) {
    await db
      .insert(heatPumpReading)
      .values(reading(u.id, { [field]: value, hourStart: new Date(Date.UTC(2026, 9, 7, i)) } as Partial<Reading>))
  }
})

test('a reading needs an existing unit, and goes with it', async () => {
  await expectConstraintViolation(
    db.insert(heatPumpReading).values(reading('00000000-0000-4000-8000-000000000000')),
    'heat_pump_reading_heat_pump_id_heat_pump_id_fk',
  )
  const u = await unit()
  await db.insert(heatPumpReading).values(reading(u.id))
  await db.delete(heatPump).where(eq(heatPump.id, u.id))
  expect(await db.select().from(heatPumpReading)).toEqual([])
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx vitest run src/lib/db/heatPumpSchema.test.ts`
Expected: FAIL — `heatPump` is not exported from `~/lib/db/schema`.

- [ ] **Step 3: Declare the tables**

`src/lib/db/schema/heatPump.ts`:
```ts
import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  check,
  date,
  doublePrecision,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Backstop for one unit-hour, kWh: a 2.5 kW unit can't use 5 kWh in an hour (ADR-0027). It
 * catches a unit slip, not real data; the service validates first. Changing it (or the
 * temperature bounds) changes the rendered CHECK text: run `bun run db:generate`.
 */
export const HEAT_PUMP_HOUR_KWH_MAX = 5
/** Plausible setpoint / indoor / outdoor temperature, °C (inclusive). */
export const HEAT_PUMP_TEMP_MIN_C = -60
export const HEAT_PUMP_TEMP_MAX_C = 60

const kwhMax = sql.raw(String(HEAT_PUMP_HOUR_KWH_MAX))
const tempMin = sql.raw(String(HEAT_PUMP_TEMP_MIN_C))
const tempMax = sql.raw(String(HEAT_PUMP_TEMP_MAX_C))

// One row per Panasonic Comfort Cloud air-to-air heat pump (ADR-0027), keyed by Comfort Cloud's
// device guid. `name` and `model` are refreshed by every sync (a rename keeps the history).
// `registered_on` is the unit's first data day, from the latest history answer's
// `deviceRegisterTime`: the backfill stops there and sets `history_complete_at`.
export const heatPump = pgTable('heat_pump', {
  id: uuid('id').primaryKey().defaultRandom(),
  guid: text('guid').notNull().unique(),
  name: text('name').notNull(),
  model: text('model').notNull(),
  registeredOn: date('registered_on', { mode: 'string' }),
  historyCompleteAt: timestamp('history_complete_at', { withTimezone: true }),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
}).enableRLS()

// NULL passes a CHECK: a missing value is allowed, a wrong one is not.
const shareCheck = (name: string, column: AnyPgColumn) =>
  check(`heat_pump_reading_${name}_check`, sql`${column} BETWEEN 0 AND 1`)
const tempCheck = (name: string, column: AnyPgColumn) =>
  check(`heat_pump_reading_${name}_check`, sql`${column} BETWEEN ${tempMin} AND ${tempMax}`)

// One row per unit and UTC hour: the hour's kWh, its heating and cooling share, and the hour's
// mean setpoint, indoor and outdoor temperature, as Comfort Cloud reports them (osTimezone
// +00:00, so rows are exact UTC hours). Written one UTC day at a time by `heatPump.replaceDay`
// (delete the unit's day, then insert, in one transaction): a re-fetched day never leaves stale
// hours, gaps stay gaps. Comfort Cloud's -255 ("no value") is never stored. Hourly rows tell when
// someone is home and heating: server-only, never logged raw, never sent to the client (only
// daily sums, ADR-0027 decision 6). The primary key serves the day replace, the oldest-day min()
// and per-unit ranges.
export const heatPumpReading = pgTable(
  'heat_pump_reading',
  {
    heatPumpId: uuid('heat_pump_id')
      .notNull()
      .references(() => heatPump.id, { onDelete: 'cascade' }),
    hourStart: timestamp('hour_start', { withTimezone: true }).notNull(),
    energyKwh: doublePrecision('energy_kwh').notNull(),
    heatShare: doublePrecision('heat_share'),
    coolShare: doublePrecision('cool_share'),
    setpointC: doublePrecision('setpoint_c'),
    insideC: doublePrecision('inside_c'),
    outsideC: doublePrecision('outside_c'),
  },
  (table) => [
    primaryKey({ name: 'heat_pump_reading_pkey', columns: [table.heatPumpId, table.hourStart] }),
    // date_bin, not date_trunc: date_trunc on timestamptz follows the session TimeZone (and is only
    // STABLE); date_bin against a UTC origin is the same everywhere (as house_energy_reading).
    check(
      'heat_pump_reading_hour_aligned_check',
      sql`date_bin('1 hour', ${table.hourStart}, timestamptz '2000-01-01 00:00:00+00') = ${table.hourStart}`,
    ),
    check(
      'heat_pump_reading_energy_kwh_check',
      sql`${table.energyKwh} >= 0 AND ${table.energyKwh} < ${kwhMax}`,
    ),
    shareCheck('heat_share', table.heatShare),
    shareCheck('cool_share', table.coolShare),
    tempCheck('setpoint_c', table.setpointC),
    tempCheck('inside_c', table.insideC),
    tempCheck('outside_c', table.outsideC),
  ],
).enableRLS()
```

`src/lib/db/schema/index.ts` — add, keeping the alphabetical order:
```ts
export * from './heatPump'
```
(between `export * from './file'` and `export * from './houseEnergy'`).

- [ ] **Step 4: Generate and apply the migration**

```bash
grep -c '^DATABASE_URL' .env.local 2>/dev/null   # → 0 (never migrate prod from a laptop)
bun run db:generate --name=heat_pump
ls drizzle/*heat_pump*.sql
grep -c "ENABLE ROW LEVEL SECURITY" drizzle/0022_heat_pump.sql      # → 2
grep -n "date_bin\|ON DELETE cascade\|heat_pump_guid_unique\|heat_pump_reading_pkey\|timestamp with time zone" drizzle/0022_heat_pump.sql
grep -n "DROP\|ALTER COLUMN\|SET DATA TYPE" drizzle/0022_heat_pump.sql || echo "additive only"
bun run db:migrate
```
Expected: `drizzle/0022_heat_pump.sql` with two `CREATE TABLE`s, both RLS lines, the eight CHECKs, the composite PK,
the unique guid, the cascading FK, every timestamp `timestamp with time zone`; `additive only`. Never hand-edit
`drizzle/meta/`.

- [ ] **Step 5: Run the schema and RLS tests**

Run: `bunx vitest run src/lib/db/heatPumpSchema.test.ts test/rls.test.ts`
Expected: PASS (the RLS test now sees both new tables with RLS on, not forced).

- [ ] **Step 6: Commit**

```bash
bun run check
git add src/lib/db/schema/heatPump.ts src/lib/db/schema/index.ts src/lib/db/heatPumpSchema.test.ts \
  drizzle/0022_heat_pump.sql drizzle/meta/0022_snapshot.json drizzle/meta/_journal.json
git commit -m "feat(heat-pumps): add the heat_pump and heat_pump_reading tables

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Schema gate — schema-design review + `migration-guard` (Non-negotiable)

**Files:** whatever the findings touch (`heatPump.ts`, a regenerated migration) · **Reviewers:** these two, in
parallel, each told to assume the schema is wrong for the queries below.

- [ ] **Step 1: Dispatch both reviewers in parallel**

`migration-guard` (agent): "Audit `drizzle/0022_heat_pump.sql`, its snapshot/journal and
`src/lib/db/schema/heatPump.ts` on branch `feat/heat-pumps-adapter` against `origin/main`: `--name=` used,
timestamptz everywhere, no destructive op, RLS on both tables, nothing in `betterAuth.ts`, and the `vercel env pull`
hazard (every Vercel deploy migrates its DB)."

Schema-design reviewer (`general-purpose` agent): "Load the `supabase-postgres-best-practices` skill first. Assume
this schema is wrong and prove it either way. Review `src/lib/db/schema/heatPump.ts` and
`drizzle/0022_heat_pump.sql` (spec: `docs/superpowers/specs/2026-10-08-heat-pumps-design.md` → Schema; ADR-0027)
against the queries that will actually run, at ≈ 17.5k reading rows a year for 2 units (3 at most), Postgres 17
(Supabase prod, plain postgres:17-alpine local/CI):
1. step 1a/1b writes, four runs a day: `INSERT … ON CONFLICT (guid) DO UPDATE SET name, model, last_seen_at`
   (≤ 3 rows); per unit and UTC day `DELETE FROM heat_pump_reading WHERE heat_pump_id = $1 AND hour_start >= $2 AND
   hour_start < $3` then `INSERT` ≤ 24 rows, in one transaction (≈ 1,400 day replaces during the one-off backfill);
   `SELECT min(hour_start) FROM heat_pump_reading WHERE heat_pump_id = $1`; `UPDATE heat_pump SET registered_on = $2,
   history_complete_at = CASE WHEN registered_on IS NOT NULL AND $2::date < registered_on THEN NULL ELSE
   history_complete_at END WHERE id = $1` (an earlier first-data day reopens the backfill) and `UPDATE heat_pump SET
   history_complete_at = $2 WHERE id = $1`; `SELECT … FROM heat_pump ORDER BY name`.
2. step 2 (`energy.overview`, every Översikt load, warm path budget ~20 ms): per unit and Stockholm month over the
   whole history — `SELECT heat_pump_id, date_trunc('month', hour_start AT TIME ZONE 'Europe/Stockholm'), sum(energy_kwh),
   sum(energy_kwh * heat_share), sum(energy_kwh * cool_share), hour-weighted avg of the temperatures, count(*),
   min/max(hour_start) FROM heat_pump_reading WHERE hour_start >= $from AND hour_start < $to GROUP BY 1, 2`.
3. step 3: the same per Stockholm day over ≤ 800 days.
Judge: the composite PK `(heat_pump_id, hour_start)` vs an extra index on `hour_start` (the plan proposes none — no
skip scan in PG 17, but the time-range reads cover most of a tiny table); `double precision` for kWh (1 Wh
resolution) and temperatures (0.25 °C steps); the CHECKs vs every valid write (0 kWh standby hours, null
temperatures and shares, −60/60 and 0/1 bounds, `date_bin` alignment on DST days); `registered_on` as `date`; the FK
`ON DELETE CASCADE` (a deleted unit takes its readings; step 4a's events will use RESTRICT); `first_seen_at` /
`last_seen_at` without defaults (the service always passes `now`); evolvability for step 4a's `heat_pump_event`.
Report findings with severity; no edits."

- [ ] **Step 2: Fix or rule on every finding**

For a schema change: edit `heatPump.ts`, delete the ungenerated-yet-unmerged `drizzle/0022_heat_pump.sql` plus its
snapshot and journal entry **only by regenerating** (`git checkout origin/main -- drizzle/meta/_journal.json`,
`rm drizzle/0022_heat_pump.sql drizzle/meta/0022_snapshot.json`, `bun run db:generate --name=heat_pump`), reset the
local DB schema the same way the migration was applied (`bun run db:down && bun run db:up && bun run db:migrate`),
re-run `bunx vitest run src/lib/db/heatPumpSchema.test.ts test/rls.test.ts`. A finding not taken goes in the PR's
*Risks / follow-ups* with the reason.

- [ ] **Step 3: Commit the fixes** (if any)

```bash
bun run check
git add src/lib/db/schema/heatPump.ts src/lib/db/heatPumpSchema.test.ts drizzle/
git commit -m "fix(heat-pumps): apply the heat pump schema review

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The service writes (`src/lib/services/heatPump/`)

**Reviewers:** `code-reviewer` + `test-completeness` (service / `errors.ts`): both `HeatPumpDomainError` codes
exercised; ADR-0002 (all DB access here, invariants as domain errors); no reading value in any message.

**Files:**
- Modify: `src/lib/db/pgError.ts`, `src/lib/db/pgError.test.ts`, `src/lib/services/houseEnergy/houseEnergy.ts`
  (refactor commit first)
- Create: `src/lib/services/heatPump/errors.ts`, `heatPump.ts`, `index.ts`, `heatPump.test.ts`

**Interfaces:**
- Consumes: `heatPump`, `heatPumpReading`, the range constants (Task 5); `utcDayBounds`, `isUtcDay`, `utcDayOf`
  (Task 1).
- Produces:
  - `pgErrorSummary(error: unknown): string` — `src/lib/db/pgError.ts`
  - ```ts
    export type HeatPump = typeof heatPump.$inferSelect
    export type HeatPumpUnitInput = { guid: string; name: string; model: string }
    export type HeatPumpHourInput = { hourStart: Date; energyKwh: number; heatShare: number | null; coolShare: number | null; setpointC: number | null; insideC: number | null; outsideC: number | null }
    export function upsertUnits(units: HeatPumpUnitInput[], now: Date): Promise<HeatPump[]>
    export function listUnits(): Promise<HeatPump[]>
    export function replaceDay(heatPumpId: string, utcDay: string, hours: readonly HeatPumpHourInput[]): Promise<{ stored: number }>
    export function oldestDay(heatPumpId: string): Promise<string | null>
    export function setRegisteredOn(heatPumpId: string, day: string): Promise<void>   // an earlier day clears history_complete_at (reopens the backfill)
    export function markHistoryComplete(heatPumpId: string, now: Date): Promise<void>
    export type HeatPumpDomainErrorCode = 'INVALID_READING' | 'UNKNOWN_HEAT_PUMP'
    export class HeatPumpDomainError extends Error { readonly code: HeatPumpDomainErrorCode }
    ```

- [ ] **Step 1 (refactor): Share the Postgres error summary**

Add the test to `src/lib/db/pgError.test.ts`:
```ts
test('pgErrorSummary names the SQLSTATE and constraint only, through drizzle’s wrapper', () => {
  const pg = Object.assign(new Error('duplicate key; Failing row contains (0.123456)'), {
    code: '23505',
    constraint: 'x_pkey',
    detail: 'Failing row contains (0.123456)',
  })
  const drizzle = Object.assign(new Error('Failed query: insert …\nparams: 0.123456'), { cause: pg })
  expect(pgErrorSummary(drizzle)).toBe(' (Postgres 23505, x_pkey)')
  expect(pgErrorSummary(Object.assign(new Error('timeout'), { code: '57014' }))).toBe(' (Postgres 57014)')
  expect(pgErrorSummary(new Error('plain'))).toBe('')
  expect(pgErrorSummary(null)).toBe('')
})
```
and `import { isUniqueViolation, pgErrorSummary } from './pgError'`.

Run `bunx vitest run src/lib/db/pgError.test.ts` → FAIL (`pgErrorSummary` not exported). Then move `pgSummary` out
of `houseEnergy.ts` into `src/lib/db/pgError.ts`, unchanged except its name:
```ts
/**
 * " (Postgres <code>, <constraint>)" from a pg error under drizzle's wrapper, or "". Never the
 * message, detail or parameters: drizzle quotes every bound value and pg's detail the failing row.
 */
export function pgErrorSummary(error: unknown): string {
  for (let e: unknown = error, depth = 0; e && depth < 3; depth++) {
    const pg = e as { code?: unknown; constraint?: unknown; cause?: unknown }
    if (typeof pg.code === 'string') {
      const constraint = typeof pg.constraint === 'string' ? `, ${pg.constraint}` : ''
      return ` (Postgres ${pg.code}${constraint})`
    }
    e = pg.cause
  }
  return ''
}
```
In `houseEnergy.ts`: delete the local `pgSummary`, `import { pgErrorSummary } from '~/lib/db/pgError'`, and call
`pgErrorSummary(error)` in `writeDay`. Then:

```bash
bunx vitest run src/lib/db/pgError.test.ts src/lib/services/houseEnergy/houseEnergy.test.ts
bun run check
git add src/lib/db/pgError.ts src/lib/db/pgError.test.ts src/lib/services/houseEnergy/houseEnergy.ts
git commit -m "refactor(db): share the Postgres error summary

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Expected: PASS, the house-energy tests unchanged.

- [ ] **Step 2: Write the failing service tests**

`src/lib/services/heatPump/heatPump.test.ts`:
```ts
import { eq } from 'drizzle-orm'
import { afterEach, expect, test, vi } from 'vitest'
import { db } from '~/lib/db'
import { HEAT_PUMP_HOUR_KWH_MAX, heatPump, heatPumpReading } from '~/lib/db/schema'
import { utcDayBounds } from '~/lib/time/utc'
import { setupDatabase } from '~test/setup'
import { HeatPumpDomainError } from './errors'
import {
  type HeatPumpHourInput,
  listUnits,
  markHistoryComplete,
  oldestDay,
  replaceDay,
  setRegisteredOn,
  upsertUnits,
} from './heatPump'

setupDatabase()

afterEach(() => {
  vi.restoreAllMocks()
})

const HOUR = 3_600_000
const NOW = new Date('2026-10-08T10:00:00Z')
const LATER = new Date('2026-10-08T16:20:00Z')
const MATSAL = { guid: 'CS-HZ25ZKE+0000000001', name: 'Matsal', model: 'CS-HZ25ZKE' }
const OVERVANING = { guid: 'CS-HZ25ZKE+0000000002', name: 'Övervåning', model: 'CS-HZ25ZKE' }
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000'

// Synthetic values only — never real readings (the repo is public).
const hour = (start: number | Date, kwh = 0.12): HeatPumpHourInput => ({
  hourStart: new Date(start),
  energyKwh: kwh,
  heatShare: 1,
  coolShare: 0,
  setpointC: 21,
  insideC: 20.5,
  outsideC: 3.25,
})
const fullDay = (day: string) => {
  const { startMs } = utcDayBounds(day)
  return Array.from({ length: 24 }, (_, i) => hour(startMs + i * HOUR, 0.1 + i / 1000))
}
const readingsOf = (heatPumpId: string) =>
  db
    .select()
    .from(heatPumpReading)
    .where(eq(heatPumpReading.heatPumpId, heatPumpId))
    .orderBy(heatPumpReading.hourStart)
async function twoUnits() {
  const [matsal, overvaning] = await upsertUnits([MATSAL, OVERVANING], NOW)
  return { matsal, overvaning }
}
const caught = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('expected a rejection')
    },
    (e: unknown) => e as Error,
  )

// ---- units ------------------------------------------------------------------

test('upsertUnits inserts new units, stamping both seen times', async () => {
  const { matsal } = await twoUnits()
  expect(matsal).toMatchObject({
    ...MATSAL,
    registeredOn: null,
    historyCompleteAt: null,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
  })
})

test('a later upsert refreshes name, model and last_seen_at, keeping id and first_seen_at', async () => {
  const { matsal } = await twoUnits()
  await setRegisteredOn(matsal.id, '2024-10-31')
  const [renamed] = await upsertUnits([{ ...MATSAL, name: 'Matsalen', model: 'CS-HZ25ZKE-2' }], LATER)
  expect(renamed).toMatchObject({
    id: matsal.id,
    name: 'Matsalen',
    model: 'CS-HZ25ZKE-2',
    firstSeenAt: NOW,
    lastSeenAt: LATER,
    registeredOn: '2024-10-31',
  })
  expect(await listUnits()).toHaveLength(2)
})

test('upsertUnits returns input order, once per guid; nothing in, nothing out', async () => {
  const rows = await upsertUnits([OVERVANING, MATSAL, { ...OVERVANING, name: 'Övervåningen' }], NOW)
  expect(rows.map((r) => r.name)).toEqual(['Övervåningen', 'Matsal'])
  expect(await upsertUnits([], NOW)).toEqual([])
})

test('listUnits orders by name', async () => {
  await upsertUnits([OVERVANING, MATSAL], NOW)
  expect((await listUnits()).map((u) => u.name)).toEqual(['Matsal', 'Övervåning'])
})

// ---- replaceDay -------------------------------------------------------------

test('stores a whole UTC day, the DST day included, and reads it back', async () => {
  const { matsal } = await twoUnits()
  for (const day of ['2026-06-10', '2026-03-29']) {
    expect(await replaceDay(matsal.id, day, fullDay(day).reverse())).toEqual({ stored: 24 })
  }
  const rows = await readingsOf(matsal.id)
  expect(rows).toHaveLength(48)
  expect(rows[0]).toEqual({ heatPumpId: matsal.id, ...hour(Date.UTC(2026, 2, 29), 0.1) })
})

test('a re-fetched day replaces only that unit’s day: gaps stay gaps, neighbours untouched', async () => {
  const { matsal, overvaning } = await twoUnits()
  for (const day of ['2026-06-09', '2026-06-10', '2026-06-11']) await replaceDay(matsal.id, day, fullDay(day))
  await replaceDay(overvaning.id, '2026-06-10', fullDay('2026-06-10'))
  const { startMs } = utcDayBounds('2026-06-10')

  await replaceDay(matsal.id, '2026-06-10', [hour(startMs, 0.3), hour(startMs + 5 * HOUR, 0.4)])

  const matsalRows = await readingsOf(matsal.id)
  expect(matsalRows).toHaveLength(24 + 2 + 24)
  expect(matsalRows.filter((r) => r.hourStart.getTime() >= startMs && r.hourStart.getTime() < startMs + 24 * HOUR).map((r) => r.energyKwh)).toEqual([0.3, 0.4])
  expect(await readingsOf(overvaning.id)).toHaveLength(24)
})

test('an empty list clears the day', async () => {
  const { matsal } = await twoUnits()
  await replaceDay(matsal.id, '2026-06-10', fullDay('2026-06-10'))
  expect(await replaceDay(matsal.id, '2026-06-10', [])).toEqual({ stored: 0 })
  expect(await readingsOf(matsal.id)).toEqual([])
})

test('null shares and temperatures are stored as null; a standby hour of 0 kWh is a reading', async () => {
  const { matsal } = await twoUnits()
  const start = utcDayBounds('2026-06-10').startMs
  await replaceDay(matsal.id, '2026-06-10', [
    { hourStart: new Date(start), energyKwh: 0, heatShare: null, coolShare: null, setpointC: null, insideC: null, outsideC: null },
  ])
  expect(await readingsOf(matsal.id)).toEqual([
    { heatPumpId: matsal.id, hourStart: new Date(start), energyKwh: 0, heatShare: null, coolShare: null, setpointC: null, insideC: null, outsideC: null },
  ])
})

test('rejects hours outside the day, off the hour, repeated, or with a value out of range — keeping the stored day', async () => {
  const { matsal } = await twoUnits()
  await replaceDay(matsal.id, '2026-06-10', fullDay('2026-06-10'))
  const { startMs, endMs } = utcDayBounds('2026-06-10')
  const at = (overrides: Partial<HeatPumpHourInput>) => ({ ...hour(startMs), ...overrides })
  const bad: [string, HeatPumpHourInput[]][] = [
    ['before the day', [hour(startMs - HOUR)]],
    ['at the next midnight', [hour(endMs)]],
    ['off the hour', [hour(startMs + 30 * 60_000)]],
    ['a repeated hour', [hour(startMs), hour(startMs)]],
    ['an invalid date', [hour(new Date(Number.NaN))]],
    ['negative kWh', [at({ energyKwh: -0.001 })]],
    ['5 kWh', [at({ energyKwh: HEAT_PUMP_HOUR_KWH_MAX })]],
    ['NaN kWh', [at({ energyKwh: Number.NaN })]],
    ['a share above 1', [at({ heatShare: 1.01 })]],
    ['a negative share', [at({ coolShare: -0.1 })]],
    ['an infinite share', [at({ heatShare: Number.POSITIVE_INFINITY })]],
    ['a hot indoor', [at({ insideC: 60.25 })]],
    ['a frozen outdoor', [at({ outsideC: -60.25 })]],
    ['a NaN setpoint', [at({ setpointC: Number.NaN })]],
  ]
  for (const [label, hours] of bad) {
    await expect(replaceDay(matsal.id, '2026-06-10', hours), label).rejects.toMatchObject({
      name: 'HeatPumpDomainError',
      code: 'INVALID_READING',
    })
  }
  expect(await readingsOf(matsal.id)).toHaveLength(24)
})

test('an INVALID_READING message names the hour and field, never the value', async () => {
  const { matsal } = await twoUnits()
  const start = utcDayBounds('2026-06-10').startMs
  const err = await caught(replaceDay(matsal.id, '2026-06-10', [{ ...hour(start), outsideC: 61.123456 }]))
  expect(err).toBeInstanceOf(HeatPumpDomainError)
  expect(err.message).toContain('hour 0')
  expect(err.message).toContain('outsideC')
  expect(err.message).not.toContain('61.123456')
})

test('replaceDay of an unknown unit is UNKNOWN_HEAT_PUMP, whatever the id looks like', async () => {
  for (const id of [UNKNOWN_ID, 'not-a-uuid']) {
    await expect(replaceDay(id, '2026-06-10', fullDay('2026-06-10'))).rejects.toMatchObject({
      code: 'UNKNOWN_HEAT_PUMP',
    })
    await expect(replaceDay(id, '2026-06-10', [])).rejects.toMatchObject({ code: 'UNKNOWN_HEAT_PUMP' })
  }
})

test('a day that is not a real YYYY-MM-DD is a RangeError (a caller bug)', async () => {
  const { matsal } = await twoUnits()
  await expect(replaceDay(matsal.id, '2026-02-30', [])).rejects.toThrow(RangeError)
})

// drizzle's query error carries every bound parameter in its message and `.params`, and pg's
// detail quotes the failing row.
test('a database failure is rethrown without any reading in it', async () => {
  const { matsal } = await twoUnits()
  const pg = Object.assign(new Error('duplicate key; Failing row contains (0.123456)'), {
    code: '23505',
    constraint: 'heat_pump_reading_pkey',
    detail: 'Failing row contains (0.123456)',
  })
  const drizzle = Object.assign(new Error('Failed query: insert …\nparams: 0.123456'), {
    params: [0.123456],
    cause: pg,
  })
  vi.spyOn(db, 'transaction').mockRejectedValueOnce(drizzle)
  const start = utcDayBounds('2026-06-10').startMs
  const err = await caught(replaceDay(matsal.id, '2026-06-10', [hour(start, 0.123456)]))
  expect(err.message).toBe('Storing heat pump readings failed (Postgres 23505, heat_pump_reading_pkey)')
  expect(err.cause).toBeUndefined()
  expect(`${err.message} ${err.stack} ${JSON.stringify(err)}`).not.toContain('0.123456')
})

// ---- oldestDay, registered_on, history_complete_at --------------------------

test('oldestDay is the UTC day of the unit’s oldest hour; null with none or for an unknown unit', async () => {
  const { matsal, overvaning } = await twoUnits()
  expect(await oldestDay(matsal.id)).toBeNull()
  await replaceDay(matsal.id, '2026-06-10', fullDay('2026-06-10'))
  await replaceDay(matsal.id, '2026-06-08', [hour(Date.UTC(2026, 5, 8, 23))])
  await replaceDay(overvaning.id, '2026-01-01', fullDay('2026-01-01'))
  expect(await oldestDay(matsal.id)).toBe('2026-06-08')
  expect(await oldestDay(UNKNOWN_ID)).toBeNull()
  expect(await oldestDay('not-a-uuid')).toBeNull()
})

test('setRegisteredOn and markHistoryComplete set their column on that unit only', async () => {
  const { matsal, overvaning } = await twoUnits()
  await setRegisteredOn(matsal.id, '2024-10-31')
  await markHistoryComplete(matsal.id, LATER)
  const [m] = await db.select().from(heatPump).where(eq(heatPump.id, matsal.id))
  const [o] = await db.select().from(heatPump).where(eq(heatPump.id, overvaning.id))
  expect(m).toMatchObject({ registeredOn: '2024-10-31', historyCompleteAt: LATER })
  expect(o).toMatchObject({ registeredOn: null, historyCompleteAt: null })
  await setRegisteredOn(matsal.id, '2024-11-27')
  expect((await listUnits())[0]).toMatchObject({ registeredOn: '2024-11-27', historyCompleteAt: LATER })
})

test('an earlier registered_on reopens the backfill; the same or a later one keeps it complete', async () => {
  const { matsal, overvaning } = await twoUnits()
  const unitRow = async (id: string) => (await db.select().from(heatPump).where(eq(heatPump.id, id)))[0]
  await setRegisteredOn(matsal.id, '2024-11-27')
  await markHistoryComplete(matsal.id, LATER)

  await setRegisteredOn(matsal.id, '2024-11-27')
  expect(await unitRow(matsal.id)).toMatchObject({ registeredOn: '2024-11-27', historyCompleteAt: LATER })
  await setRegisteredOn(matsal.id, '2024-12-01')
  expect(await unitRow(matsal.id)).toMatchObject({ registeredOn: '2024-12-01', historyCompleteAt: LATER })

  await setRegisteredOn(matsal.id, '2024-10-31')
  expect(await unitRow(matsal.id)).toMatchObject({ registeredOn: '2024-10-31', historyCompleteAt: null })

  // A first-time set on a unit already marked complete (no stored date to compare) keeps it.
  await markHistoryComplete(overvaning.id, LATER)
  await setRegisteredOn(overvaning.id, '2024-11-27')
  expect(await unitRow(overvaning.id)).toMatchObject({ registeredOn: '2024-11-27', historyCompleteAt: LATER })
})

test('setRegisteredOn and markHistoryComplete of an unknown unit are UNKNOWN_HEAT_PUMP', async () => {
  for (const id of [UNKNOWN_ID, 'not-a-uuid']) {
    await expect(setRegisteredOn(id, '2024-10-31')).rejects.toMatchObject({ code: 'UNKNOWN_HEAT_PUMP' })
    await expect(markHistoryComplete(id, NOW)).rejects.toMatchObject({ code: 'UNKNOWN_HEAT_PUMP' })
  }
})

test('setRegisteredOn refuses a day that is not a real date', async () => {
  const { matsal } = await twoUnits()
  await expect(setRegisteredOn(matsal.id, '2024-13-01')).rejects.toThrow(RangeError)
})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `bunx vitest run src/lib/services/heatPump/heatPump.test.ts`
Expected: FAIL — `Failed to resolve import "./errors"`.

- [ ] **Step 4: Implement**

`src/lib/services/heatPump/errors.ts`:
```ts
export type HeatPumpDomainErrorCode =
  // A reading lies outside the UTC day, is off the whole hour or repeats an hour, or a value is
  // not finite or outside the table's CHECKs. A stored day is all-or-nothing: a bad row fails
  // the day, not the run (as the Emaldo sync's rejected days).
  | 'INVALID_READING'
  // No heat_pump row has this id.
  | 'UNKNOWN_HEAT_PUMP'

export class HeatPumpDomainError extends Error {
  constructor(
    public readonly code: HeatPumpDomainErrorCode,
    message: string = code,
  ) {
    super(message)
    this.name = 'HeatPumpDomainError'
  }
}
```

`src/lib/services/heatPump/heatPump.ts`:
```ts
import { and, asc, eq, gte, lt, min, type SQL, sql } from 'drizzle-orm'
import { db } from '~/lib/db'
import { pgErrorSummary } from '~/lib/db/pgError'
import {
  HEAT_PUMP_HOUR_KWH_MAX,
  HEAT_PUMP_TEMP_MAX_C,
  HEAT_PUMP_TEMP_MIN_C,
  heatPump,
  heatPumpReading,
} from '~/lib/db/schema'
import { isUtcDay, utcDayBounds, utcDayOf } from '~/lib/time/utc'
import { HeatPumpDomainError } from './errors'

export type HeatPump = typeof heatPump.$inferSelect

/** A unit as Comfort Cloud lists it (the same shape as `ComfortCloudUnit`). */
export type HeatPumpUnitInput = { guid: string; name: string; model: string }

/**
 * One unit-hour (the same shape as `ComfortCloudHour`, declared here so callers needn't reach
 * into an effect). Presence data: never log it.
 */
export type HeatPumpHourInput = {
  hourStart: Date
  energyKwh: number
  heatShare: number | null
  coolShare: number | null
  setpointC: number | null
  insideC: number | null
  outsideC: number | null
}

const HOUR_MS = 3_600_000
/** Problems quoted in one error message. */
const MAX_PROBLEMS = 5
/** Any hex UUID Postgres accepts; anything else can't be a heat_pump id. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHARE_FIELDS = ['heatShare', 'coolShare'] as const
const TEMP_FIELDS = ['setpointC', 'insideC', 'outsideC'] as const

/**
 * Inserts the units Comfort Cloud lists, or refreshes name, model and last_seen_at of known ones
 * (by guid; first_seen_at and the backfill columns are kept). Returns the rows in input order,
 * once per guid (the last entry of a repeated guid wins).
 */
export async function upsertUnits(units: HeatPumpUnitInput[], now: Date): Promise<HeatPump[]> {
  const byGuid = new Map(units.map((u) => [u.guid, u]))
  if (byGuid.size === 0) return []
  const rows = await db
    .insert(heatPump)
    .values(
      [...byGuid.values()].map((u) => ({
        guid: u.guid,
        name: u.name,
        model: u.model,
        firstSeenAt: now,
        lastSeenAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: heatPump.guid,
      set: {
        name: sql`excluded.name`,
        model: sql`excluded.model`,
        lastSeenAt: sql`excluded.last_seen_at`,
      },
    })
    .returning()
  const byStoredGuid = new Map(rows.map((r) => [r.guid, r]))
  return [...byGuid.keys()].flatMap((guid) => byStoredGuid.get(guid) ?? [])
}

/** Every unit, by name (then guid, for a stable order). */
export async function listUnits(): Promise<HeatPump[]> {
  return db.select().from(heatPump).orderBy(asc(heatPump.name), asc(heatPump.guid))
}

// What's wrong with `hours` as one unit's readings of `[startMs, endMs)`. Messages name the hour
// index and field only — never a value (ADR-0027: hourly rows are presence data).
function readingProblems(startMs: number, endMs: number, hours: readonly HeatPumpHourInput[]) {
  const problems: string[] = []
  const seen = new Set<number>()
  for (const [i, h] of hours.entries()) {
    const t = h.hourStart.getTime()
    if (!(t >= startMs && t < endMs)) problems.push(`hour ${i} starts outside the day`)
    else if ((t - startMs) % HOUR_MS !== 0) problems.push(`hour ${i} is not on a whole hour`)
    else if (seen.has(t)) problems.push(`hour ${i} repeats an hour`)
    seen.add(t)
    const kwh = h.energyKwh
    if (!(Number.isFinite(kwh) && kwh >= 0 && kwh < HEAT_PUMP_HOUR_KWH_MAX)) {
      problems.push(`hour ${i}: energyKwh is out of range`)
    }
    for (const field of SHARE_FIELDS) {
      const v = h[field]
      if (v !== null && !(Number.isFinite(v) && v >= 0 && v <= 1)) {
        problems.push(`hour ${i}: ${field} is not a share`)
      }
    }
    for (const field of TEMP_FIELDS) {
      const v = h[field]
      if (v !== null && !(Number.isFinite(v) && v >= HEAT_PUMP_TEMP_MIN_C && v <= HEAT_PUMP_TEMP_MAX_C)) {
        problems.push(`hour ${i}: ${field} is out of range`)
      }
    }
  }
  return problems
}

/**
 * Stores one unit's UTC day, replacing whatever that unit's day held: delete its hours in
 * `[day, day + 24 h)`, then insert, in one transaction (as `houseEnergy.replaceDay`). Validated
 * first, so a rejected day leaves the stored one untouched. An empty list clears the day. A
 * database failure is rethrown with only the SQLSTATE and constraint (drizzle's error quotes
 * every bound value).
 */
export async function replaceDay(
  heatPumpId: string,
  utcDay: string,
  hours: readonly HeatPumpHourInput[],
): Promise<{ stored: number }> {
  const { startMs, endMs } = utcDayBounds(utcDay)
  const problems = readingProblems(startMs, endMs, hours)
  if (problems.length > 0) {
    const more = problems.length > MAX_PROBLEMS ? ` (+${problems.length - MAX_PROBLEMS} more)` : ''
    throw new HeatPumpDomainError(
      'INVALID_READING',
      `${problems.slice(0, MAX_PROBLEMS).join('; ')}${more}`,
    )
  }
  if (!UUID_RE.test(heatPumpId)) throw new HeatPumpDomainError('UNKNOWN_HEAT_PUMP')
  try {
    await db.transaction(async (tx) => {
      const [unit] = await tx.select({ id: heatPump.id }).from(heatPump).where(eq(heatPump.id, heatPumpId))
      if (!unit) throw new HeatPumpDomainError('UNKNOWN_HEAT_PUMP')
      await tx
        .delete(heatPumpReading)
        .where(
          and(
            eq(heatPumpReading.heatPumpId, heatPumpId),
            gte(heatPumpReading.hourStart, new Date(startMs)),
            lt(heatPumpReading.hourStart, new Date(endMs)),
          ),
        )
      if (hours.length === 0) return
      await tx.insert(heatPumpReading).values(
        hours.map((h) => ({
          heatPumpId,
          hourStart: h.hourStart,
          energyKwh: h.energyKwh,
          heatShare: h.heatShare,
          coolShare: h.coolShare,
          setpointC: h.setpointC,
          insideC: h.insideC,
          outsideC: h.outsideC,
        })),
      )
    })
  } catch (error) {
    if (error instanceof HeatPumpDomainError) throw error
    throw new Error(`Storing heat pump readings failed${pgErrorSummary(error)}`)
  }
  return { stored: hours.length }
}

/** The UTC day of the unit's oldest stored hour (the backfill's cursor), or null with none. */
export async function oldestDay(heatPumpId: string): Promise<string | null> {
  if (!UUID_RE.test(heatPumpId)) return null
  const [row] = await db
    .select({ first: min(heatPumpReading.hourStart) })
    .from(heatPumpReading)
    .where(eq(heatPumpReading.heatPumpId, heatPumpId))
  return row?.first ? utcDayOf(row.first.getTime()) : null
}

/**
 * Records the unit's first data day ('YYYY-MM-DD', from `deviceRegisterTime`). A date earlier
 * than the stored one clears `history_complete_at` in the same statement, so the backfill (which
 * walks units without it) reopens down to the new date. Postgres evaluates every SET expression
 * against the old row, so the CASE compares with the previously stored `registered_on`.
 */
export async function setRegisteredOn(heatPumpId: string, day: string): Promise<void> {
  if (!isUtcDay(day)) throw new RangeError(`Not a YYYY-MM-DD day: ${day}`)
  await updateUnit(heatPumpId, {
    registeredOn: day,
    historyCompleteAt: sql`CASE WHEN ${heatPump.registeredOn} IS NOT NULL AND ${day}::date < ${heatPump.registeredOn} THEN NULL ELSE ${heatPump.historyCompleteAt} END`,
  })
}

/** Marks the unit's backfill as having reached `registered_on`. */
export async function markHistoryComplete(heatPumpId: string, now: Date): Promise<void> {
  await updateUnit(heatPumpId, { historyCompleteAt: now })
}

async function updateUnit(
  heatPumpId: string,
  set: { registeredOn?: string; historyCompleteAt?: Date | SQL },
): Promise<void> {
  if (!UUID_RE.test(heatPumpId)) throw new HeatPumpDomainError('UNKNOWN_HEAT_PUMP')
  const rows = await db
    .update(heatPump)
    .set(set)
    .where(eq(heatPump.id, heatPumpId))
    .returning({ id: heatPump.id })
  if (rows.length === 0) throw new HeatPumpDomainError('UNKNOWN_HEAT_PUMP')
}
```

`src/lib/services/heatPump/index.ts`:
```ts
export * from './errors'
export * from './heatPump'
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bunx vitest run src/lib/services/heatPump/ src/lib/db/heatPumpSchema.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
bun run check
git add src/lib/services/heatPump/
git commit -m "feat(heat-pumps): add the heat pump service writes

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: CLAUDE.md map, branch review, pre-PR gate, roadmap row, PR

**Files:** `CLAUDE.md`, `docs/superpowers/roadmaps/2026-10-08-heat-pumps.md`, whatever review findings touch ·
**Reviewers:** the Phase 5 gates below.

- [ ] **Step 1: CLAUDE.md code map** (no env var yet: `PANASONIC_*` arrive with the source in 1b)

In the `src/lib/` block of the code map:
- `db/` line: add `heatPump` to `schema/{…}` (after `houseEnergy`), and `pgError (unique-violation mapping, `pgErrorSummary`)`.
- `services/` line: add `heatPump` after `houseEnergy`.
- `effects/` line: after `emaldo (…)`, add
  `comfortCloud (Panasonic heat pumps, ADR-0027: Auth0 PKCE password login — tough-cookie jar + htmlparser2 hidden inputs — x-cfc-api-key, UTC hours; client only until step 1b adds the facade)`.
- After the `time/stockholm.ts` line add:
  `    time/utc.ts                 client-safe UTC day helpers (Comfort Cloud's whole UTC days)`

```bash
bun run check
git add CLAUDE.md
git commit -m "docs(heat-pumps): map the Comfort Cloud client and heat pump service

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 2: Branch review (feature-workflow Phase 5)** — dispatch in parallel, each told the branch is wrong
  and not up to spec until proven otherwise:
  - `migration-guard` **and** the schema-design reviewer (schema + `drizzle/` changed; re-run even though Task 6 ran,
    against the final diff).
  - `test-completeness`: effect + service + both `errors.ts`; every `ComfortCloudError` code the client throws and
    both `HeatPumpDomainError` codes exercised.
  - `code-reviewer`: ADR-0001/0002/0003/0019/0026/0027 adherence over `git diff origin/main...HEAD`.
  - General correctness: `/code-review high` (≈ 2,500 lines with tests).
  - Security: `/security-review` — third-party credentials and tokens: nothing secret in messages, causes, stacks or
    the repo; redirects never auto-followed and never off the Auth0 host; the cookie jar per login; the Play Store
    lookup sends nothing of ours.
  - Fix every confirmed finding here (or rule on it in the PR's *Risks*), re-run the touched tests, one conventional
    commit per fix.

- [ ] **Step 3: Pre-PR gate (feature-workflow, verbatim)**

```bash
bun run check                    # Biome writes fixes; commit anything it changed
bun run check:ci                 # = CI's Check (lint): must pass with no writes
bun run build                    # = Check (build); includes tsc --noEmit (= Check (types))
bun run db:up && bun run db:migrate   # tests need the local Postgres container
bun run test                     # = Test: node (per-test schema) + browser projects
# sv/en message keys match (CI doesn't check this):
bun -e 'const sv=Object.keys(await Bun.file("messages/sv.json").json()),en=Object.keys(await Bun.file("messages/en.json").json());const d=[...sv.filter(k=>!en.includes(k)).map(k=>"en missing "+k),...en.filter(k=>!sv.includes(k)).map(k=>"sv missing "+k)];console.log(d.join("\n")||"sv/en keys match");process.exit(d.length?1:0)'
```
Expected: all green, "sv/en keys match" (no messages added). No UI changed → no browser check. Browser files that fail
only after a fresh `bun install` (Vite re-optimising deps) are re-run alone before calling them failures.

Then nothing private is staged:
```bash
git diff origin/main...HEAD --stat
git diff origin/main...HEAD | grep -n -i "PANASONIC_[A-Z]*=[^ ]\|data/private\|scratchpad" || echo "clean"
```
Expected: only `src/lib/**`, `drizzle/**`, `package.json`, `bun.lock`, `CLAUDE.md`, the roadmap; `clean`.

- [ ] **Step 4: Push, open the PR** with `.github/PULL_REQUEST_TEMPLATE.md`. Title (exact):
  `feat(heat-pumps): add the Comfort Cloud client and heat pump storage`

```bash
git push -u origin feat/heat-pumps-adapter
gh pr create --title "feat(heat-pumps): add the Comfort Cloud client and heat pump storage" --body-file "$SCRATCH/pr-1a.md"
```
`$SCRATCH/pr-1a.md` (the session scratchpad; tick boxes only with what you ran):
```markdown
## Why

Step 1a of the heat pumps roadmap ([ADR-0027](docs/adr/0027-heat-pump-energy-data.md),
[roadmap](docs/superpowers/roadmaps/2026-10-08-heat-pumps.md)): a TypeScript port of the Panasonic Comfort Cloud
client and the tables that store each heat pump's UTC hours. Nothing calls it yet; the sync is step 1b.

## What changed

- `src/lib/effects/comfortCloud/`: `createComfortCloudClient` — Auth0 PKCE password login (port of
  aio-panasonic-comfort-cloud 2026.8.9), `x-cfc-api-key` pinned against upstream, app-version lookup on 401/4106,
  `units`, UTC `dayHours`, `monthDays`. No facade until 1b adds the source.
- New deps: `tough-cookie` (the Auth0 cookie jar) and `htmlparser2` (hidden inputs; `wctx` is entity-encoded JSON),
  chosen over hand-rolling per CLAUDE.md.
- `heat_pump` + `heat_pump_reading` (RLS, CHECKs, `date_bin` hour alignment) and `services/heatPump` writes.

## Decisions (ruled while planning; the spec is amended to match)

- `date_bin` hour alignment (`date_trunc` on timestamptz follows the session TimeZone); the raw guid in the history
  body (upstream's `/`→`f` is for URL paths only); `x-app-timestamp` = the UTC wall clock.
- Password step `400`/`401` → `auth_failed` (suspect `user` + `password`), `403` → `forbidden`, `5xx` → `unreachable`.
- Optional `{ signal, stats }` on the client's calls (for 1b's run line); the extra MFA check behind a code-less
  redirect; a 5-minute login block after `auth_failed`; redirects followed only on the Auth0 origin; `4103` without a
  re-login.
- `temperatureUnit ≠ 0` (not Celsius) → `unexpected_response`; a nameless unit is named by its model;
  `setRegisteredOn` with an earlier date clears `history_complete_at` (the backfill reopens).
- Index on `hour_start`: <the schema review's ruling, Task 6>.

## Verification

- [ ] `bun run check` clean
- [ ] `bun run build` passes (tsc + bundle)
- [ ] `bun run test` passes
- [ ] Responsive on desktop + mobile — _N/A (no UI)_

## Risks / follow-ups

- Unofficial API: a login change fails the source closed (from 1b) and is fixed from upstream by hand.
- Checkpoint 1a (local live run against the owner's account) runs after merge.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

- [ ] **Step 5: Roadmap row 1a** with the PR link and status `PR open`:

```
| 1a | Adapter + storage, nothing calls it yet: … | [plan](../plans/2026-10-08-heat-pumps-1a-adapter-storage.md) | [#NN](https://github.com/<owner>/<repo>/pull/NN) | PR open | |
```
(`gh pr view --json url -q .url` gives the link.)

```bash
git add docs/superpowers/roadmaps/2026-10-08-heat-pumps.md
git commit -m "docs(heat-pumps): track step 1a

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push
```

- [ ] **Step 6: CI** — wait for `CI Success` and `Validate Conventional Commit title`; fix and push if red. The
  owner squash-merges.

---

### Task 9: STOP — checkpoint 1a runs after merge (owner, or the next session)

Don't start step 1b in this session. After the merge, the roadmap's **checkpoint 1 (local)** must pass first:

> A one-off script (not committed) runs the new adapter with the `.env.local` credentials: login succeeds, both units
> are listed (Matsal, Övervåning, `CS-HZ25ZKE`), and yesterday's 24 hourly kWh per unit, stored through `replaceDay`
> into the local DB, equal what the Python probe returns for the same day. The adapter logs no password, token, api
> key or raw HTML (grep the run's output).

Everything below lives in **that session's scratchpad** (`$SCRATCH`), never in the repo. Run from the main checkout
on up-to-date `main` after `bun run db:up && bun run db:migrate`. `.env.local` must hold `PANASONIC_USER` /
`PANASONIC_PASSWORD` (owner prerequisite, done 2026-10-08) and **no** `DATABASE_URL` line. Never print `.env.local`.

- [ ] **Step 1: The TypeScript side** — `$SCRATCH/checkpoint-1a/checkpoint-1a.ts`:

```ts
// LOCAL ONLY — session scratchpad, never commit. Heat pumps checkpoint 1a: the repo's Comfort
// Cloud client logs in, lists the units, fetches one UTC day per unit and stores it through
// heatPump.replaceDay into the LOCAL database; prints the stored kWh as JSON on stdout.
// Run from the repo root:  bun "$CP/checkpoint-1a.ts" [YYYY-MM-DD] > "$CP/ts.json" 2> "$CP/ts.log"
import '/Users/lukas/prog/videbacken/scripts/loadEnv'
import { and, asc, eq, gte, lt } from 'drizzle-orm'
import { db } from '/Users/lukas/prog/videbacken/src/lib/db'
import { heatPumpReading } from '/Users/lukas/prog/videbacken/src/lib/db/schema'
import { createComfortCloudClient, newCallStats } from '/Users/lukas/prog/videbacken/src/lib/effects/comfortCloud'
import { replaceDay, setRegisteredOn, upsertUnits } from '/Users/lukas/prog/videbacken/src/lib/services/heatPump'
import { utcDayBounds, utcDayOf } from '/Users/lukas/prog/videbacken/src/lib/time/utc'

const url = process.env.DATABASE_URL ?? ''
if (!/localhost|127\.0\.0\.1/.test(url)) throw new Error('checkpoint 1a writes to the LOCAL database only')
const { PANASONIC_USER: user, PANASONIC_PASSWORD: password } = process.env
if (!user || !password) throw new Error('PANASONIC_USER / PANASONIC_PASSWORD missing from .env.local')

const day = process.argv[2] ?? utcDayOf(Date.now() - 86_400_000) // yesterday, UTC
const { startMs, endMs } = utcDayBounds(day)
const stats = newCallStats()
const client = createComfortCloudClient({ fetch: globalThis.fetch, user, password })

const units = await client.units({ stats })
console.error(`day ${day}; units: ${units.map((u) => `${u.name} (${u.model}, …${u.guid.slice(-4)})`).join(', ')}`)
const stored = await upsertUnits(units, new Date())
const out: Record<string, (number | null)[]> = {}
for (const unit of stored) {
  const history = await client.dayHours(unit.guid, day, { stats })
  await setRegisteredOn(unit.id, history.registeredOn)
  const { stored: n } = await replaceDay(unit.id, day, history.rows)
  const rows = await db
    .select({ hourStart: heatPumpReading.hourStart, kwh: heatPumpReading.energyKwh })
    .from(heatPumpReading)
    .where(
      and(
        eq(heatPumpReading.heatPumpId, unit.id),
        gte(heatPumpReading.hourStart, new Date(startMs)),
        lt(heatPumpReading.hourStart, new Date(endMs)),
      ),
    )
    .orderBy(asc(heatPumpReading.hourStart))
  const byHour = new Map(rows.map((r) => [r.hourStart.getUTCHours(), r.kwh]))
  out[unit.name] = Array.from({ length: 24 }, (_, h) => byHour.get(h) ?? null)
  console.error(`${unit.name}: registered ${history.registeredOn}, ${n} hours stored`)
}
console.error(
  `requests ${stats.requests}, retries ${stats.retries}, logins ${stats.logins}, fetch ${Math.round(stats.fetchMs)} ms`,
)
console.log(JSON.stringify(out))
process.exit(0)
```

- [ ] **Step 2: The Python side** (upstream, same day, `osTimezone +00:00`) — `$SCRATCH/checkpoint-1a/probe.py`:

```python
# LOCAL ONLY — session scratchpad. Prints {unit name: [24 kWh or null]} for one UTC day via
# aio-panasonic-comfort-cloud 2026.8.9. Never prints credentials or tokens.
import asyncio, json, pathlib, sys
import aiohttp
from aio_panasonic_comfort_cloud import ApiClient, constants

def env(repo):
    vals = {}
    for name in ('.env', '.env.local'):
        f = pathlib.Path(repo, name)
        if f.exists():
            for line in f.read_text().splitlines():
                if '=' in line and not line.lstrip().startswith('#'):
                    k, v = line.split('=', 1)
                    vals[k.strip()] = v.strip().strip('"').strip("'")
    return vals

async def main(repo, day, state):
    e = env(repo)
    async with aiohttp.ClientSession() as s:
        c = ApiClient(e['PANASONIC_USER'], e['PANASONIC_PASSWORD'], s, token_file_name=state)
        await c.start_session()
        out = {}
        for d in c.get_devices():
            h = await c.history(d.id, constants.DataMode.Day, day.replace('-', ''), '+00:00')
            rows = {r['dataTime'][-2:]: r['consumption'] for r in h['parameters']['historyDataList']}
            out[d.name] = [rows[k] if rows.get(k, -1) >= 0 else None for k in (f'{i:02d}' for i in range(24))]
        print(json.dumps(out))

asyncio.run(main(*sys.argv[1:4]))
```

- [ ] **Step 3: Run both and compare**

```bash
CP="$SCRATCH/checkpoint-1a" && mkdir -p -m 700 "$CP"
cd /Users/lukas/prog/videbacken
DAY=$(date -u -v-1d +%F)            # macOS; yesterday in UTC
bun "$CP/checkpoint-1a.ts" "$DAY" > "$CP/ts.json" 2> "$CP/ts.log"; echo "exit $?"
cat "$CP/ts.log"                     # unit names, models, guid tails, counts only
python3 -m venv "$CP/venv" && "$CP/venv/bin/pip" install -q aio-panasonic-comfort-cloud==2026.8.9
"$CP/venv/bin/python" -I "$CP/probe.py" /Users/lukas/prog/videbacken "$DAY" "$CP/pcc-token.json" > "$CP/py.json"
rm -f "$CP/pcc-token.json"           # upstream's token file: delete it
cat > "$CP/compare.ts" <<'EOF'
const [tsPath, pyPath] = process.argv.slice(2)
const ts = await Bun.file(tsPath).json() as Record<string, (number | null)[]>
const py = await Bun.file(pyPath).json() as Record<string, (number | null)[]>
let bad = 0
for (const name of new Set([...Object.keys(ts), ...Object.keys(py)])) {
  const a = ts[name], b = py[name]
  if (!a || !b) { console.log(`${name}: only in ${a ? 'TS' : 'Python'}`); bad++; continue }
  const diff = a.flatMap((v, i) => (v === b[i] || (v !== null && b[i] !== null && Math.abs(v - (b[i] as number)) < 1e-9) ? [] : [i]))
  console.log(`${name}: ${a.filter((v) => v !== null).length} hours, ${diff.length ? `MISMATCH at hours ${diff.join(',')}` : 'match'}`)
  bad += diff.length
}
process.exit(bad ? 1 : 0)
EOF
bun "$CP/compare.ts" "$CP/ts.json" "$CP/py.json"
```
Expected: `ts.log` lists Matsal and Övervåning, both `CS-HZ25ZKE`, `registered 2024-10-31` / `2024-11-27`, 24 hours
stored each, `logins 1`; `compare.ts` prints `match` for both units (24 hours each) and exits 0.

- [ ] **Step 4: Nothing secret in the run's output**

```bash
cat > "$CP/leaks.ts" <<'EOF'
import '/Users/lukas/prog/videbacken/scripts/loadEnv'
const text = (await Promise.all(process.argv.slice(2).map((p) => Bun.file(p).text()))).join('\n')
const checks: [string, (t: string) => boolean][] = [
  ['password', (t) => !!process.env.PANASONIC_PASSWORD && t.includes(process.env.PANASONIC_PASSWORD)],
  ['user', (t) => !!process.env.PANASONIC_USER && t.includes(process.env.PANASONIC_USER)],
  ['JWT-like token', (t) => /eyJ[A-Za-z0-9_-]{10,}/.test(t)],
  ['Bearer', (t) => t.includes('Bearer')],
  ['api key', (t) => /[0-9a-f]{9}cfc[0-9a-f]{55}/.test(t)],
  ['raw HTML', (t) => /<html|<input|<form/i.test(t)],
  ['full guid', (t) => /CS-[A-Z0-9]+\+\d{6,}/.test(t)],
]
const hits = checks.filter(([, test]) => test(text)).map(([name]) => name)
console.log(hits.length ? `LEAK: ${hits.join(', ')}` : 'clean')
process.exit(hits.length ? 1 : 0)
EOF
bun "$CP/leaks.ts" "$CP/ts.log" "$CP/ts.json"
```
Expected: `clean`. (The script prints only which class matched, never the value.)

- [ ] **Step 5: Record the result** in the roadmap's row 1a "Checkpoint result" (e.g. "passed 2026-10-DD: both units,
  24/24 hours match upstream, output clean") in a small `docs(heat-pumps): record checkpoint 1a` PR (or in step 1b's
  PR if the owner says so), set the status to `checkpoint passed`, then delete `$CP` (it holds the household's hourly
  kWh). If anything mismatches, debug with `superpowers:systematic-debugging` before step 1b starts.

---

## Self-review (done while writing)

- **Spec coverage:** login steps 1–5 (Tasks 3, 4), api headers + key (Task 1), app version (Task 4), the three calls
  and their parsing (Tasks 2, 4), error mapping (Tasks 2–4), cookies/HTML library choice (Decisions, Task 1),
  logging rule (Global Constraints, Task 4 grep, Task 9 leak check), `heat_pump` / `heat_pump_reading` (Task 5),
  schema review (Task 6), `upsertUnits` / `replaceDay` / `oldestDay` / `setRegisteredOn` / `markHistoryComplete` and
  both domain codes (Task 7), the Testing section's adapter + service bullets (Tasks 2–7; month/day sums are steps
  2–3), checkpoint 1 (Task 9). Out of this step by the roadmap: credentials, source literal, facade, sync, reads.
- **Type consistency:** `ComfortCloudHour` ≡ `HeatPumpHourInput`; `ComfortCloudCallStats` satisfies fetchWithRetry's
  `{ requests, retries }`; `SendOpts` is the only send option type; `passwordLogin` returns `string`.
- **Review Focus:** each of the five lines has its named test in Tasks 2–4.
