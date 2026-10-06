# Charging settings step 3b — credentials UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin sets, replaces or removes each source's credentials from `/charging/settings`: a key button per
credential tile, a credentials dialog (save → that source's sync), inline "Konfigurera" / "Uppdatera inloggning" links
on the tiles, an "Elnätsavtal" card for the facility ID, and overview alerts that deep-link straight into the dialog.

**Architecture:** Pure UI over step 3a's `credentials.{status,set,clear}` procedures. A client-safe copy layer
(`integrationCredentialsMessage.ts`) names sources and fields and says what an error means; a pure
`credentialLink(health)` decides when a health state points at the credentials. `CredentialsDialog` is a
`ResponsiveDialog` + `useAppForm` (ADR-0005), opened by URL state `?dialog=credentials&source=<source>` (ADR-0013). The
page owns the one `useSyncNow()` and runs the post-save sync, so the tile's "Synkar…" follows it.

**Tech Stack:** TanStack Start/Router + Query, oRPC 1.14 (`isDefinedError`, typed `data`), `@tanstack/react-form` v1,
shadcn (Radix), Paraglide, Vitest browser mode (Playwright Chromium), bun.

**Spec:** `docs/superpowers/specs/2026-10-05-charging-settings-design.md` — "Step 3b — credentials UI", plus "Credentials
per source" (suspect fields). ADR: `docs/adr/0026-integration-credential-store.md`. Roadmap:
`docs/superpowers/roadmaps/2026-10-05-charging-settings.md`.

## Global Constraints

- **No value ever reaches the client.** `credentials.status` returns origins only; inputs are **never pre-filled**;
  `secret` fields use `type="password"`; all inputs `autoComplete="off"`.
- Client code may only `import type` from services (`clientSafe.browser.test.tsx` guards it). Shared vocabulary comes
  from `~/lib/integrationCredentials` (client-safe).
- Every user-facing string in `messages/sv.json` (source of truth) **and** `messages/en.json` (key-complete). Run
  `bun run i18n:compile` after editing messages.
- Forms via `useAppForm` (no `useState` for field values). URL dialog state via `useUrlDialog` (ADR-0013).
- Mutations via `orpc.credentials.set` / `orpc.credentials.clear` (admin-only). After success, invalidate
  `orpc.credentials.key()` and `orpc.evCharging.key()`, then run `syncSource(source)` for `zaptec | skoda | emaldo`;
  nothing for `gridTariff`.
- Responsive at desktop, tablet and mobile widths; touch targets 44 px on coarse pointers (`pointer-coarse:`).
- Logging via `~/lib/logger` only; never `console.*`.
- Conventional commits, ≤72 chars, one hat per commit, trailer
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Never run two vitest processes at once (shared local DB). Reviewers must not run vitest while the implementer does.
- One-shot browser tests: `bunx vitest run --project browser <path>` (`test:components` watches).

## Decisions this plan makes where the spec is silent (flag in the PR)

1. `credentials.status` is a **critical** read on the settings route (one cheap query); the Elnätsavtal card sits in
   a `SectionSkeleton name="charging-grid"` because client navigations don't await critical reads (ADR-0025).
2. The credential deep link also covers `not_configured` (label "Konfigurera") and any failure with stored suspect
   fields (e.g. Emaldo `unexpected_response` → app id/secret), besides the spec's `auth_failed`,
   `credentials_unreadable` and Škoda `forbidden`.
3. The page passes `onChanged(source)` into the dialog instead of the dialog calling its own `useSyncNow()`: a second
   hook instance would not drive the tile's pending state.
4. After "Ta bort sparade uppgifter" the dialog closes (like after a save).
5. Closing the dialog returns focus to that source's key button (`id="credentials-<source>"`).
6. The key button wraps its own `TooltipProvider` so the tile works outside the app shell (tests, any future page).

## Review Focus

1. **A deep link to a source with no credentials** (`?dialog=credentials&source=elpris`) or a history link to a
   credential-only source (`?dialog=syncRuns&source=gridTariff`) must be cleaned from the URL, not open an empty
   overlay → Task 5 tests "cleans a credentials link to a source without credentials" and "cleans a history link to
   gridTariff".
2. **Two invalid fields from the server** (`INVALID_FIELD`, `fields: ['vin','homeCoordinates']`) must each show their
   own message and keep the dialog open; editing one clears only that one → Task 2 test "INVALID_FIELD lands on every
   listed field; editing one clears only its own".
3. **The encryption key missing while a row is stored**: inputs disabled, but "Ta bort sparade uppgifter" still works
   (clearing needs no key) → Task 2 test "missing key: inputs disabled, remove still offered".
4. **A save that fails for a non-field reason** (`ENCRYPTION_KEY_MISSING`, network) keeps the dialog open, toasts, and
   runs no sync → Task 2 test "a failed save toasts, stays open and runs no sync".
5. **Reopening the dialog after a failed save** must start with empty inputs and no stale errors → Task 2 test
   "reopening starts clean".

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `src/lib/integrationCredentials.ts` | modify | `isCredentialSource` guard |
| `src/lib/integrationCredentialsMessage.ts` | create | client-safe copy: field labels/hints, invalid-field messages, suspect line, dialog title |
| `src/lib/integrationCredentialsMessage.test.ts` | create | node tests for the copy layer |
| `src/components/evCharging/credentialLink.ts` | create | `credentialLink(health)`, `credentialsButtonId(source)` |
| `src/components/evCharging/credentialLink.test.ts` | create | node tests for the link rule |
| `src/components/evCharging/CredentialsButton.tsx` | create | the key icon button with tooltip (tile + grid card) |
| `src/components/form/TextField.tsx` | modify | `description: ReactNode`, `disabled` prop |
| `src/components/evCharging/CredentialsDialog.tsx` | create | the dialog: statuses, form, save, remove-confirm |
| `src/components/evCharging/CredentialsDialog.browser.test.tsx` | create | dialog tests |
| `src/components/evCharging/SyncSourceTile.tsx` | modify | key button, header room, inline link, suspect line |
| `src/components/evCharging/SyncSourceTile.browser.test.tsx` | modify | tests for the above |
| `src/components/evCharging/SyncSourcesPanel.tsx` | modify | pass `onOpenCredentials` to credential tiles |
| `src/components/evCharging/GridTariffCard.tsx` | create | "Elnätsavtal" card |
| `src/components/evCharging/GridTariffCard.browser.test.tsx` | create | card tests |
| `src/routes/_authenticated/charging/settings.tsx` | modify | status query, `dialog=credentials`, widened `source`, cleanup, dialog, grid card |
| `src/routes/_authenticated/charging/-settingsPage.browser.test.tsx` | modify | route tests |
| `src/components/evCharging/SettingsLink.tsx` | modify | `search` accepts the credentials deep link |
| `src/components/evCharging/SyncHealthAlert.tsx` (+ test) | modify | deep link for credential failures |
| `src/components/evCharging/CredentialExpiryAlert.tsx` (+ test) | modify | deep link "Byt nyckel" |
| `messages/{sv,en}.json` | modify | new keys; expiry copy |
| `src/emails/CredentialExpiryEmail.tsx` (+ test) | modify | comment + assertion follow the new copy |
| `docs/runbooks/skoda-api-key.md` | modify | GUI first, env fallback |
| `src/bones/*` | regenerate | `charging-sources` (tile changed) + new `charging-grid` |
| roadmap | modify | step 3b row |

---

### Task 0: Check main still matches the spec

- [ ] **Step 1:** Confirm the 3a surface exists as the plan assumes:

```bash
grep -n "status: adminProcedure\|set: adminProcedure\|clear: adminProcedure" src/lib/orpc/procedures/credentials.ts
grep -n "credentials" src/lib/orpc/router.ts
grep -n "suspectFields" src/lib/services/integrationSync/integrationSync.ts | head -3
grep -n "encryptionKeyConfigured\|unreadable" src/lib/services/integrationCredential/integrationCredential.ts | head
grep -n "source: z.enum(INTEGRATION_SOURCES)" src/routes/_authenticated/charging/settings.tsx
```

Expected: all three procedures; `credentials: credentialsRouter` registered; `adminDetail.suspectFields`; status has
`encryptionKeyConfigured` / `unreadable`; the route's `source` is still integration-only. Any mismatch → stop and amend
this plan.

---

### Task 1: Copy layer and link rule (client-safe, pure)

**Files:**
- Modify: `src/lib/integrationCredentials.ts`
- Create: `src/lib/integrationCredentialsMessage.ts`, `src/lib/integrationCredentialsMessage.test.ts`
- Create: `src/components/evCharging/credentialLink.ts`, `src/components/evCharging/credentialLink.test.ts`
- Modify: `messages/sv.json`, `messages/en.json`

**Interfaces — Produces:**
- `isCredentialSource(source: string): source is CredentialSource`
- `credentialFieldLabel(source, field): string`, `credentialFieldHint(source, field): string | undefined`
- `invalidFieldMessage(source, field): string`
- `suspectFieldsMessage(source, fields: readonly string[]): string | null` — "VIN och API-nyckel fungerade inte vid senaste synken."
- `credentialsTitle(source): string` — "Inloggning för Škoda" / "Elnätsavtal"
- `credentialLink(health: SourceHealth): { source: CredentialSource; kind: 'configure' | 'update' } | null`
- `credentialsButtonId(source: CredentialSource): string` → `credentials-<source>`

- [ ] **Step 1: Add messages** (sv / en; `{source}`/`{fields}` are inputs):

| key | sv | en |
|---|---|---|
| `charging_credentials_title` | Inloggning för {source} | Sign-in for {source} |
| `charging_grid_title` | Elnätsavtal | Grid contract |
| `charging_credentials_field_zaptec_username` | Användarnamn | Username |
| `charging_credentials_field_password` | Lösenord | Password |
| `charging_credentials_field_skoda_apiKey` | API-nyckel | API key |
| `charging_credentials_field_skoda_vin` | VIN | VIN |
| `charging_credentials_field_skoda_homeCoordinates` | Laddboxens position | Charger location |
| `charging_credentials_field_emaldo_user` | Användare | User |
| `charging_credentials_field_emaldo_appId` | App-id | App ID |
| `charging_credentials_field_emaldo_appSecret` | App-hemlighet | App secret |
| `charging_credentials_field_gridTariff_facilityId` | Anläggnings-ID | Facility ID |
| `charging_credentials_hint_email` | E-postadressen du loggar in med. | The email address you sign in with. |
| `charging_credentials_hint_vin` | 17 tecken, står i registreringsbeviset. | 17 characters, on the registration certificate. |
| `charging_credentials_hint_home` | Latitud,longitud, t.ex. 59.3293,18.0686. Används för att se om bilen står hemma. | Latitude,longitude, e.g. 59.3293,18.0686. Used to tell whether the car is at home. |
| `charging_credentials_hint_emaldo_app` | Från Emaldo-appen för Android; kan bytas ut av Emaldo. | From the Emaldo Android app; Emaldo can rotate it. |
| `charging_credentials_hint_facility` | 18 siffror, står på elnätsfakturan. | 18 digits, on the grid invoice. |
| `charging_credentials_invalid_vin` | Ett VIN har 17 tecken: siffror och bokstäver utom I, O och Q. | A VIN has 17 characters: digits and letters except I, O and Q. |
| `charging_credentials_invalid_home` | Skriv latitud,longitud, t.ex. 59.3293,18.0686. | Enter latitude,longitude, e.g. 59.3293,18.0686. |
| `charging_credentials_invalid_facility` | Anläggnings-ID har 18 siffror. | A facility ID has 18 digits. |
| `charging_credentials_invalid_other` | Värdet går inte att spara: det är för långt eller innehåller otillåtna tecken. | The value can't be saved: it is too long or contains characters that aren't allowed. |
| `charging_credentials_suspect` | {fields} fungerade inte vid senaste synken. | {fields} didn't work at the last sync. |

- [ ] **Step 2: Write the failing tests**

`src/lib/integrationCredentialsMessage.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { CREDENTIAL_FIELDS, CREDENTIAL_SOURCES } from '~/lib/integrationCredentials'
import { m } from '~/paraglide/messages'
import {
  credentialFieldLabel,
  credentialsTitle,
  invalidFieldMessage,
  suspectFieldsMessage,
} from './integrationCredentialsMessage'

describe('credential copy', () => {
  test('every field of every source has a label', () => {
    for (const source of CREDENTIAL_SOURCES)
      for (const field of CREDENTIAL_FIELDS[source])
        expect(credentialFieldLabel(source, field)).not.toBe('')
  })
  test('format fields get their own invalid message, the rest a shared one', () => {
    expect(invalidFieldMessage('skoda', 'vin')).toBe(m.charging_credentials_invalid_vin())
    expect(invalidFieldMessage('skoda', 'homeCoordinates')).toBe(m.charging_credentials_invalid_home())
    expect(invalidFieldMessage('gridTariff', 'facilityId')).toBe(m.charging_credentials_invalid_facility())
    expect(invalidFieldMessage('zaptec', 'password')).toBe(m.charging_credentials_invalid_other())
  })
  test('suspect fields read as one sentence, in vocabulary order, unknown names dropped', () => {
    expect(suspectFieldsMessage('skoda', ['vin', 'apiKey', 'bogus'])).toBe(
      m.charging_credentials_suspect({ fields: 'API-nyckel och VIN' }),
    )
    expect(suspectFieldsMessage('skoda', [])).toBeNull()
    expect(suspectFieldsMessage('skoda', ['bogus'])).toBeNull()
  })
  test('the grid source is titled as the contract, the others as sign-in', () => {
    expect(credentialsTitle('gridTariff')).toBe(m.charging_grid_title())
    expect(credentialsTitle('skoda')).toBe(m.charging_credentials_title({ source: 'Škoda' }))
  })
})
```

(The node project runs in the base locale `sv`; check `src/lib/integrationHealthMessage.test.ts` or equivalent for
how existing copy tests pin the locale and follow it.)

`src/components/evCharging/credentialLink.test.ts`:

```ts
import { expect, test } from 'vitest'
import { credentialLink } from './credentialLink'
import type { SourceHealth } from './syncHealth'

const base: SourceHealth = {
  source: 'skoda', state: 'failing', running: false, progress: null, lastAttemptAt: null,
  lastSuccessAt: null, failingSince: null, consecutiveFailures: 1, code: null, adminDetail: null,
}
const detail = (suspectFields: string[] | null) =>
  ({ lastErrorMessage: null, credentialExpiry: null, suspectFields }) as never

test('not configured → configure', () => {
  expect(credentialLink({ ...base, state: 'not_configured', code: 'not_configured' })).toEqual({
    source: 'skoda', kind: 'configure',
  })
})
test('credential failures → update', () => {
  for (const code of ['auth_failed', 'credentials_unreadable'] as const)
    expect(credentialLink({ ...base, source: 'zaptec', code })).toEqual({ source: 'zaptec', kind: 'update' })
  expect(credentialLink({ ...base, code: 'forbidden' })).toEqual({ source: 'skoda', kind: 'update' })
})
test('forbidden is a credential problem only for Škoda', () => {
  expect(credentialLink({ ...base, source: 'zaptec', code: 'forbidden' })).toBeNull()
})
test('any failure with stored suspect fields → update', () => {
  expect(
    credentialLink({ ...base, source: 'emaldo', code: 'unexpected_response', adminDetail: detail(['appId']) }),
  ).toEqual({ source: 'emaldo', kind: 'update' })
})
test('elpris never links; ok and plain outages never link', () => {
  expect(credentialLink({ ...base, source: 'elpris', state: 'not_configured', code: 'not_configured' })).toBeNull()
  expect(credentialLink({ ...base, state: 'ok' })).toBeNull()
  expect(credentialLink({ ...base, code: 'unreachable' })).toBeNull()
})
```

(Match `adminDetail`'s real shape from `integrationSync.ts:36-40`; adjust `detail()` if it has more fields.)

- [ ] **Step 3:** Run `bunx vitest run src/lib/integrationCredentialsMessage.test.ts src/components/evCharging/credentialLink.test.ts` → FAIL (modules missing).

- [ ] **Step 4: Implement**

`src/lib/integrationCredentials.ts` — append:

```ts
export const isCredentialSource = (source: string): source is CredentialSource =>
  (CREDENTIAL_SOURCES as readonly string[]).includes(source)
```

`src/lib/integrationCredentialsMessage.ts`:

```ts
// Client-safe copy for GUI-set credentials (ADR-0026): labels, hints and what an error means, per source
// and field. Same pattern as integrationHealthMessage.ts: Paraglide `m` plus dependency-free vocabulary only.
import { getIntlLocale } from '~/lib/i18n/format'
import { integrationSourceName } from '~/lib/integrationHealthMessage'
import { CREDENTIAL_FIELDS, type CredentialSource } from '~/lib/integrationCredentials'
import { m } from '~/paraglide/messages'

export function credentialsTitle(source: CredentialSource): string {
  return source === 'gridTariff'
    ? m.charging_grid_title()
    : m.charging_credentials_title({ source: integrationSourceName(source) })
}

export function credentialFieldLabel(source: CredentialSource, field: string): string {
  switch (`${source}.${field}`) {
    case 'zaptec.username': return m.charging_credentials_field_zaptec_username()
    case 'zaptec.password':
    case 'emaldo.password': return m.charging_credentials_field_password()
    case 'skoda.apiKey': return m.charging_credentials_field_skoda_apiKey()
    case 'skoda.vin': return m.charging_credentials_field_skoda_vin()
    case 'skoda.homeCoordinates': return m.charging_credentials_field_skoda_homeCoordinates()
    case 'emaldo.user': return m.charging_credentials_field_emaldo_user()
    case 'emaldo.appId': return m.charging_credentials_field_emaldo_appId()
    case 'emaldo.appSecret': return m.charging_credentials_field_emaldo_appSecret()
    case 'gridTariff.facilityId': return m.charging_credentials_field_gridTariff_facilityId()
    default: return field
  }
}

export function credentialFieldHint(source: CredentialSource, field: string): string | undefined {
  switch (`${source}.${field}`) {
    case 'zaptec.username':
    case 'emaldo.user': return m.charging_credentials_hint_email()
    case 'skoda.vin': return m.charging_credentials_hint_vin()
    case 'skoda.homeCoordinates': return m.charging_credentials_hint_home()
    case 'emaldo.appId':
    case 'emaldo.appSecret': return m.charging_credentials_hint_emaldo_app()
    case 'gridTariff.facilityId': return m.charging_credentials_hint_facility()
    default: return undefined
  }
}

/** What `INVALID_FIELD` means for one field: the format rule where there is one (the service's validation). */
export function invalidFieldMessage(source: CredentialSource, field: string): string {
  switch (`${source}.${field}`) {
    case 'skoda.vin': return m.charging_credentials_invalid_vin()
    case 'skoda.homeCoordinates': return m.charging_credentials_invalid_home()
    case 'gridTariff.facilityId': return m.charging_credentials_invalid_facility()
    default: return m.charging_credentials_invalid_other()
  }
}

/** "API-nyckel och VIN fungerade inte vid senaste synken." — vocabulary order; null when none is known. */
export function suspectFieldsMessage(source: CredentialSource, fields: readonly string[]): string | null {
  const known = (CREDENTIAL_FIELDS[source] as readonly string[]).filter((f) => fields.includes(f))
  if (known.length === 0) return null
  const names = new Intl.ListFormat(getIntlLocale(), { type: 'conjunction' }).format(
    known.map((f) => credentialFieldLabel(source, f)),
  )
  return m.charging_credentials_suspect({ fields: names })
}
```

(Biome will reflow the one-line `case … return` forms; that is fine.)

`src/components/evCharging/credentialLink.ts`:

```ts
import { type CredentialSource, isCredentialSource } from '~/lib/integrationCredentials'
import type { SourceHealth } from './syncHealth'

export type CredentialLink = { source: CredentialSource; kind: 'configure' | 'update' }

/**
 * Whether a source's health points at its credentials, and so links into the credentials dialog:
 * unconfigured → "Konfigurera"; a refused or unreadable sign-in, Škoda's forbidden (key or VIN), or any
 * failure the sync blamed on named fields → "Uppdatera inloggning". Elpris has no credentials.
 */
export function credentialLink(health: SourceHealth): CredentialLink | null {
  const { source } = health
  if (!isCredentialSource(source)) return null
  if (health.state === 'not_configured') return { source, kind: 'configure' }
  if (health.state === 'ok' || health.code === null) return null
  const credentialCode =
    health.code === 'auth_failed' ||
    health.code === 'credentials_unreadable' ||
    (source === 'skoda' && health.code === 'forbidden')
  const suspects = (health.adminDetail?.suspectFields?.length ?? 0) > 0
  return credentialCode || suspects ? { source, kind: 'update' } : null
}

/** The key button's id, so a dialog opened from a link or URL can return focus to it. */
export const credentialsButtonId = (source: CredentialSource) => `credentials-${source}`
```

- [ ] **Step 5:** `bun run i18n:compile && bunx vitest run src/lib/integrationCredentialsMessage.test.ts src/components/evCharging/credentialLink.test.ts` → PASS. `bun run typecheck` clean.

- [ ] **Step 6: Commit** `feat(charging): add credential copy and link rule`

**Reviewers:** `code-reviewer` + reviewer loading `web-design-guidelines` (copy clarity, list formatting, a11y of text).

---

### Task 2: `CredentialsDialog`

**Files:**
- Modify: `src/components/form/TextField.tsx` (`description?: React.ReactNode`; `disabled?: boolean` → `disabled: disabled || isSubmitting`)
- Create: `src/components/evCharging/CredentialsDialog.tsx`, `CredentialsDialog.browser.test.tsx`
- Modify: `messages/{sv,en}.json`

**Interfaces:**
- Consumes: Task 1's copy functions; `RouterOutputs['credentials']['status']`; `orpc.credentials.set/clear`.
- Produces:
```ts
export type CredentialStatus = RouterOutputs['credentials']['status']
export function CredentialsDialog(props: {
  source: CredentialSource | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
  status: CredentialStatus | undefined
  /** Current suspect fields of the source (health.adminDetail.suspectFields), if any. */
  suspectFields: readonly string[] | null | undefined
  /** After a successful save or remove: the page runs that source's sync. */
  onChanged: (source: CredentialSource) => void
  onCloseAutoFocus?: (event: Event) => void
}): JSX.Element
```

- [ ] **Step 1: Messages**

| key | sv | en |
|---|---|---|
| `charging_credentials_description` | Lämna ett fält tomt för att behålla det som är sparat. | Leave a field empty to keep what is saved. |
| `charging_credentials_skoda_help` | Skapa nyckeln i MyŠkoda-appen och klistra in den här. | Create the key in the MyŠkoda app and paste it here. |
| `charging_credentials_skoda_link` | Öppna API-nycklar i MyŠkoda | Open API keys in MyŠkoda |
| `charging_credentials_origin_stored` | Sparad i appen · {date} | Saved in the app · {date} |
| `charging_credentials_origin_env` | Från miljövariabel | From an environment variable |
| `charging_credentials_origin_missing` | Saknas | Missing |
| `charging_credentials_field_suspect` | Fungerade inte vid senaste synken | Didn't work at the last sync |
| `charging_credentials_key_missing` | Appen saknar CREDENTIALS_ENCRYPTION_KEY – uppgifter kan inte sparas. | The app has no CREDENTIALS_ENCRYPTION_KEY – credentials can't be saved. |
| `charging_credentials_unreadable` | De sparade uppgifterna går inte att läsa. Fyll i alla fält igen. | The saved credentials can't be read. Fill in every field again. |
| `charging_credentials_reenter_field` | Fyll i det här fältet också – de sparade uppgifterna går inte att läsa. | Fill in this field too – the saved credentials can't be read. |
| `charging_credentials_nothing_to_save` | Fyll i minst ett fält. | Fill in at least one field. |
| `charging_credentials_saved` | Sparat | Saved |
| `charging_credentials_save_error` | Uppgifterna kunde inte sparas. | The credentials couldn't be saved. |
| `charging_credentials_remove` | Ta bort sparade uppgifter | Remove saved credentials |
| `charging_credentials_remove_title` | Ta bort sparade uppgifter? | Remove saved credentials? |
| `charging_credentials_remove_confirm` | De sparade uppgifterna för {source} tas bort. Miljövariablerna gäller igen, om de finns. | The saved credentials for {source} are removed. The environment variables apply again, if set. |
| `charging_credentials_removed` | Sparade uppgifter borttagna | Saved credentials removed |
| `charging_credentials_remove_error` | Uppgifterna kunde inte tas bort. | The credentials couldn't be removed. |

- [ ] **Step 2: Write the failing tests** — `CredentialsDialog.browser.test.tsx`, mocking `~/lib/orpc/client` and `sonner`
like `TariffDialog.browser.test.tsx:9-32`:

```tsx
import { ORPCError } from '@orpc/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { type CredentialStatus, CredentialsDialog } from './CredentialsDialog'

const { setFn, clearFn, toastMock } = vi.hoisted(() => ({
  setFn: vi.fn(), clearFn: vi.fn(), toastMock: { success: vi.fn(), error: vi.fn() },
}))
vi.mock('~/lib/orpc/client', () => ({
  orpc: {
    credentials: {
      set: { mutationOptions: (o: Record<string, unknown>) => ({ ...o, mutationFn: setFn }) },
      clear: { mutationOptions: (o: Record<string, unknown>) => ({ ...o, mutationFn: clearFn }) },
      key: () => ['credentials'],
    },
    evCharging: { key: () => ['evCharging'] },
  },
}))
vi.mock('sonner', () => ({ toast: toastMock }))

const SAVED = new Date('2026-10-05T10:00:00Z')
function status(over: Partial<CredentialStatus> = {}, skoda: Partial<CredentialStatus['sources']['skoda']> = {}): CredentialStatus {
  const missing = { origin: 'missing' } as const
  return {
    encryptionKeyConfigured: true,
    sources: {
      zaptec: { fields: { username: missing, password: missing }, updatedAt: null, unreadable: false },
      skoda: {
        fields: { apiKey: { origin: 'stored' }, vin: { origin: 'env' }, homeCoordinates: missing },
        updatedAt: SAVED, unreadable: false, ...skoda,
      },
      emaldo: { fields: { user: missing, password: missing, appId: missing, appSecret: missing }, updatedAt: null, unreadable: false },
      gridTariff: { fields: { facilityId: missing }, updatedAt: null, unreadable: false },
    },
    ...over,
  }
}

const onChanged = vi.fn()
const onOpenChange = vi.fn()
function dialog(props: Partial<Parameters<typeof CredentialsDialog>[0]> = {}) {
  return (
    <CredentialsDialog source="skoda" open onOpenChange={onOpenChange} status={status()}
      suspectFields={null} onChanged={onChanged} {...props} />
  )
}
beforeEach(() => {
  setFn.mockReset().mockResolvedValue({ source: 'skoda', fieldsSet: ['apiKey'] })
  clearFn.mockReset().mockResolvedValue({ cleared: true })
  for (const f of [onChanged, onOpenChange, toastMock.success, toastMock.error]) f.mockReset()
})
afterEach(() => vi.restoreAllMocks())

test('each field shows its origin, and every input starts empty', async () => {
  const screen = await renderWithProviders(dialog())
  await expect.element(screen.getByText(/Sparad i appen ·/)).toBeVisible()
  await expect.element(screen.getByText(m.charging_credentials_origin_env())).toBeVisible()
  await expect.element(screen.getByText(m.charging_credentials_origin_missing())).toBeVisible()
  for (const name of ['API-nyckel', 'VIN', 'Laddboxens position'])
    await expect.element(screen.getByLabelText(name)).toHaveValue('')
  // Secrets are password inputs; the VIN is plain text.
  expect(screen.getByLabelText('API-nyckel').element().getAttribute('type')).toBe('password')
  expect(screen.getByLabelText('VIN').element().getAttribute('type')).toBe('text')
  expect(screen.getByLabelText('API-nyckel').element().getAttribute('autocomplete')).toBe('off')
})

test('a suspect field gets its red line', async () => {
  const screen = await renderWithProviders(dialog({ suspectFields: ['vin'] }))
  await expect.element(screen.getByText(m.charging_credentials_field_suspect())).toBeVisible()
})

test('Škoda links to the MyŠkoda key page', async () => {
  const screen = await renderWithProviders(dialog())
  await expect
    .element(screen.getByRole('link', { name: m.charging_credentials_skoda_link() }))
    .toHaveAttribute('href', 'https://go.skoda.eu/api-keys')
})

test('a blank submit is refused without calling the server', async () => {
  const screen = await renderWithProviders(dialog())
  await screen.getByRole('button', { name: m.common_save() }).click()
  await expect.element(screen.getByText(m.charging_credentials_nothing_to_save())).toBeVisible()
  expect(setFn).not.toHaveBeenCalled()
})

test('save sends only the filled fields, toasts, closes and runs the sync', async () => {
  const screen = await renderWithProviders(dialog())
  await screen.getByLabelText('API-nyckel').fill('new-key')
  await screen.getByRole('button', { name: m.common_save() }).click()
  await vi.waitFor(() => expect(onChanged).toHaveBeenCalledWith('skoda'))
  expect(setFn.mock.calls[0][0]).toEqual({ source: 'skoda', fields: { apiKey: 'new-key' } })
  expect(toastMock.success).toHaveBeenCalledWith(m.charging_credentials_saved())
  expect(onOpenChange).toHaveBeenCalledWith(false)
})

test('INVALID_FIELD lands on every listed field; editing one clears only its own', async () => {
  setFn.mockRejectedValue(new ORPCError('INVALID_FIELD', { defined: true, data: { fields: ['vin', 'homeCoordinates'] } }))
  const screen = await renderWithProviders(dialog())
  await screen.getByLabelText('VIN').fill('x')
  await screen.getByLabelText('Laddboxens position').fill('y')
  await screen.getByRole('button', { name: m.common_save() }).click()
  await expect.element(screen.getByText(m.charging_credentials_invalid_vin())).toBeVisible()
  await expect.element(screen.getByText(m.charging_credentials_invalid_home())).toBeVisible()
  expect(onChanged).not.toHaveBeenCalled()
  await screen.getByLabelText('VIN').fill('xy')
  await expect.element(screen.getByText(m.charging_credentials_invalid_vin())).not.toBeInTheDocument()
  await expect.element(screen.getByText(m.charging_credentials_invalid_home())).toBeVisible()
})

test('REENTER_ALL_FIELDS marks the empty fields', async () => {
  setFn.mockRejectedValue(new ORPCError('REENTER_ALL_FIELDS', { defined: true, data: { fields: ['vin', 'homeCoordinates'] } }))
  const screen = await renderWithProviders(dialog({ status: status({}, { unreadable: true }) }))
  await expect.element(screen.getByText(m.charging_credentials_unreadable())).toBeVisible()
  await screen.getByLabelText('API-nyckel').fill('k')
  await screen.getByRole('button', { name: m.common_save() }).click()
  await expect.element(screen.getByText(m.charging_credentials_reenter_field()).first()).toBeVisible()
  expect(screen.getByText(m.charging_credentials_reenter_field()).elements()).toHaveLength(2)
})

test('a failed save toasts, stays open and runs no sync', async () => {
  setFn.mockRejectedValue(new ORPCError('ENCRYPTION_KEY_MISSING', { defined: true }))
  const screen = await renderWithProviders(dialog())
  await screen.getByLabelText('API-nyckel').fill('k')
  await screen.getByRole('button', { name: m.common_save() }).click()
  await vi.waitFor(() => expect(toastMock.error).toHaveBeenCalled())
  expect(onChanged).not.toHaveBeenCalled()
  expect(onOpenChange).not.toHaveBeenCalledWith(false)
})

test('missing key: inputs disabled, remove still offered', async () => {
  const screen = await renderWithProviders(dialog({ status: status({ encryptionKeyConfigured: false }) }))
  await expect.element(screen.getByText(m.charging_credentials_key_missing())).toBeVisible()
  await expect.element(screen.getByLabelText('API-nyckel')).toBeDisabled()
  await expect.element(screen.getByRole('button', { name: m.common_save() })).toBeDisabled()
  await expect.element(screen.getByRole('button', { name: m.charging_credentials_remove() })).toBeVisible()
})

test('remove asks first, then clears and runs the sync', async () => {
  const screen = await renderWithProviders(dialog())
  await screen.getByRole('button', { name: m.charging_credentials_remove() }).click()
  const confirm = screen.getByRole('alertdialog')
  await expect.element(confirm).toBeVisible()
  expect(clearFn).not.toHaveBeenCalled()
  await confirm.getByRole('button', { name: m.charging_credentials_remove() }).click()
  await vi.waitFor(() => expect(clearFn).toHaveBeenCalled())
  expect(clearFn.mock.calls[0][0]).toEqual({ source: 'skoda' })
  await vi.waitFor(() => expect(onChanged).toHaveBeenCalledWith('skoda'))
})

test('nothing stored: no remove button', async () => {
  const screen = await renderWithProviders(dialog({ source: 'zaptec' }))
  await expect.element(screen.getByLabelText('Användarnamn')).toBeVisible()
  expect(screen.getByRole('button', { name: m.charging_credentials_remove() }).elements()).toHaveLength(0)
})

test('reopening starts clean', async () => {
  setFn.mockRejectedValue(new ORPCError('INVALID_FIELD', { defined: true, data: { fields: ['vin'] } }))
  const screen = await renderWithProviders(dialog())
  await screen.getByLabelText('VIN').fill('x')
  await screen.getByRole('button', { name: m.common_save() }).click()
  await expect.element(screen.getByText(m.charging_credentials_invalid_vin())).toBeVisible()
  await screen.rerender(dialog({ open: false, source: undefined }))
  await screen.rerender(dialog())
  await expect.element(screen.getByLabelText('VIN')).toHaveValue('')
  await expect.element(screen.getByText(m.charging_credentials_invalid_vin())).not.toBeInTheDocument()
})
```

(If `renderWithProviders` returns a different rerender API, follow `test/browser/render.tsx`. `ORPCError`'s
`defined: true` is what `isDefinedError` checks — verify against `TariffDialog.browser.test.tsx`'s rejection helper.)

- [ ] **Step 3:** Run `bunx vitest run --project browser src/components/evCharging/CredentialsDialog.browser.test.tsx` → FAIL.

- [ ] **Step 4: Implement** `CredentialsDialog.tsx`:

```tsx
import { isDefinedError } from '@orpc/client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangleIcon, ExternalLinkIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Alert, AlertDescription } from '~/components/ui/alert'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '~/components/ui/alert-dialog'
import { Button } from '~/components/ui/button'
import {
  ResponsiveDialog, ResponsiveDialogContent, ResponsiveDialogDescription, ResponsiveDialogFooter,
  ResponsiveDialogHeader, ResponsiveDialogTitle,
} from '~/components/ui/responsive-dialog'
import { useAppForm, useStore } from '~/hooks/form'
import {
  CREDENTIAL_FIELDS, type CredentialSource, credentialFieldKind,
} from '~/lib/integrationCredentials'
import {
  credentialFieldHint, credentialFieldLabel, credentialsTitle, invalidFieldMessage,
} from '~/lib/integrationCredentialsMessage'
import { integrationSourceName } from '~/lib/integrationHealthMessage'
import { orpc, type RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { formatDate } from './format'

export type CredentialStatus = RouterOutputs['credentials']['status']

const SKODA_KEYS_URL = 'https://go.skoda.eu/api-keys'

// One source's credentials (ADR-0026), opened by URL state (ADR-0013). Never shows a value: each field says
// where its value comes from, and a blank input keeps what is stored. Saving or removing runs that source's
// sync through `onChanged`, so the tile's health shows whether the new values work.
export function CredentialsDialog({ source, open, onOpenChange, status, suspectFields, onChanged, onCloseAutoFocus }: Props) {
  // Keep the last source while the close animation runs (the URL clears first).
  const [shown, setShown] = useState(source)
  if (source && source !== shown) setShown(source)
  const current = source ?? shown
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md" onCloseAutoFocus={onCloseAutoFocus}>
        {current ? (
          <>
            <ResponsiveDialogHeader>
              <ResponsiveDialogTitle>{credentialsTitle(current)}</ResponsiveDialogTitle>
              <ResponsiveDialogDescription>{m.charging_credentials_description()}</ResponsiveDialogDescription>
            </ResponsiveDialogHeader>
            {/* key: a fresh form (empty inputs, no stale errors) on every open and per source. */}
            {open ? (
              <CredentialsForm
                key={current}
                source={current}
                status={status}
                suspectFields={suspectFields ?? []}
                onDone={(changed) => {
                  if (changed) onChanged(current)
                  onOpenChange(false)
                }}
              />
            ) : null}
          </>
        ) : null}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
```

Note: rendering the form only while `open` re-mounts it on each open (Review Focus 5) at the cost of an empty body
during the close animation; if that flashes visibly in Phase 6, keep the form mounted and key it by an open counter
instead (`useState` incremented when `open` turns true).

`CredentialsForm` (same file):
- `fields = CREDENTIAL_FIELDS[source]`; `defaultValues = Object.fromEntries(fields.map((f) => [f, '']))`.
- `const sourceStatus = status?.sources[source]`; `keyMissing = status?.encryptionKeyConfigured === false`;
  `stored = sourceStatus ? Object.values(sourceStatus.fields).some((f) => f.origin === 'stored') || sourceStatus.unreadable : false`.
- Server field errors as state, like `TariffDialog`'s `takenDay`: `const [serverErrors, setServerErrors] = useState<Record<string, { value: string; message: string }>>({})`.
  Each field's `validators.onChange: ({ value }) => serverErrors[f] && serverErrors[f].value === value ? { message: serverErrors[f].message } : undefined`.
  After `setServerErrors`, an effect runs `form.validateField(f, 'change')` + marks it touched for every key, and focuses the first one (`document.getElementById(f)?.focus()` once `isSubmitting` is false, as in `TariffDialog`).
- Form-level validator `onSubmit: ({ value }) => Object.values(value).every((v) => v.trim() === '') ? m.charging_credentials_nothing_to_save() : undefined`; render it under the fields with `<form.Subscribe selector={(s) => s.errorMap.onSubmit}>` as `<p role="alert" className="text-destructive text-sm">`.
- `set = useMutation(orpc.credentials.set.mutationOptions({ onSettled: invalidate }))` where `invalidate` invalidates `orpc.credentials.key()` and `orpc.evCharging.key()`.
- `onSubmit`: build `fields` from non-blank values only; `await set.mutateAsync({ source, fields } as never)` (the input is a discriminated union; cast once, typed at the call by `source`); on success `toast.success(m.charging_credentials_saved())`, `onDone(true)`. On error:
  - `isDefinedError(err) && err.code === 'INVALID_FIELD'` → `setServerErrors` with each listed field (known ones only) → `invalidFieldMessage(source, f)`, value = the submitted value;
  - `REENTER_ALL_FIELDS` → each listed field → `m.charging_credentials_reenter_field()`, value `''`;
  - otherwise `toast.error(m.charging_credentials_save_error())` (keep open).
- Body, top to bottom: `keyMissing` → `<Alert variant="destructive"><AlertTriangleIcon/><AlertDescription>{m.charging_credentials_key_missing()}</AlertDescription></Alert>`;
  else `sourceStatus?.unreadable` → same with `m.charging_credentials_unreadable()`; Škoda → a paragraph
  `m.charging_credentials_skoda_help()` + `<a href={SKODA_KEYS_URL} target="_blank" rel="noreferrer">` with `ExternalLinkIcon`; then each field:

```tsx
<form.AppField
  key={f}
  name={f}
  validators={{ onChange: serverError(f) }}
  children={(field) => (
    <field.TextField
      label={credentialFieldLabel(source, f)}
      type={credentialFieldKind(source, f) === 'secret' ? 'password' : 'text'}
      autoComplete="off"
      disabled={keyMissing}
      description={
        <>
          {originLine(sourceStatus, f)}
          {credentialFieldHint(source, f) ? <span className="block">{credentialFieldHint(source, f)}</span> : null}
          {suspectFields.includes(f) ? (
            <span className="block text-destructive">{m.charging_credentials_field_suspect()}</span>
          ) : null}
        </>
      }
    />
  )}
/>
```

  where `originLine` returns `m.charging_credentials_origin_stored({ date: formatDate(updatedAt) })` / `_env()` /
  `_missing()`, or `null` when `sourceStatus` is undefined (unknown).
- Footer: left, when `stored`, a `variant="ghost"` destructive-text button `m.charging_credentials_remove()` opening a
  local `AlertDialog` (`useState` for its open flag — UI state, not a field value). Its action:
  `clear.mutate({ source }, { onSuccess: () => { toast.success(m.charging_credentials_removed()); onDone(true) }, onError: () => toast.error(m.charging_credentials_remove_error()) })`, closing the confirm first. Right:
  `<form.CancelButton onClick={() => onDone(false)}>` + `<form.SubmitButton label={m.common_save()} />`, the submit
  disabled when `keyMissing` (check `SubmitButton`'s props; add a `disabled` prop there if it has none).
  On narrow screens the footer stacks (`ResponsiveDialogFooter` already does `flex-col-reverse sm:flex-row`); put the
  remove button in a `sm:mr-auto` wrapper.

- [ ] **Step 5:** Tests → PASS. `bun run typecheck`, `bun run check`.
- [ ] **Step 6: Commit** `feat(charging): add the credentials dialog`

**Reviewers:** `code-reviewer` + reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

---

### Task 3: Tile key button, inline link and suspect line

**Files:**
- Create: `src/components/evCharging/CredentialsButton.tsx`
- Modify: `SyncSourceTile.tsx`, `SyncSourceTile.browser.test.tsx`, `SyncSourcesPanel.tsx`, `messages/{sv,en}.json`

**Interfaces:**
- Produces: `CredentialsButton({ source, label, onClick })` — ghost `size="icon-sm"` `KeyRoundIcon` button, `id={credentialsButtonId(source)}`, `aria-label={label}`, tooltip `label`, `pointer-coarse:size-11`, wrapped in its own `TooltipProvider`.
- `SyncSourceTile` gains `onOpenCredentials?: () => void` (absent → no key button, no inline link).
- `SyncSourcesPanel` gains `onOpenCredentials: (source: CredentialSource) => void`; passes it to tiles where `isCredentialSource(e.source)`.

- [ ] **Step 1: Messages:** `charging_credentials_button` "Inloggning för {source}" / "Sign-in for {source}";
  `charging_credentials_configure` "Konfigurera" / "Set up"; `charging_credentials_update` "Uppdatera inloggning" /
  "Update sign-in".

- [ ] **Step 2: Failing tests** (append to `SyncSourceTile.browser.test.tsx`, using its `tile()` helper):

```tsx
test('a credential source has a key button named for it; without the handler there is none', async () => {
  const onOpen = vi.fn()
  const screen = await renderWithProviders(tile(ok, { onOpenCredentials: onOpen }))
  const key = screen.getByRole('button', { name: m.charging_credentials_button({ source: 'Zaptec' }) })
  await key.click()
  expect(onOpen).toHaveBeenCalledOnce()
  const bare = await renderWithProviders(tile({ ...ok, source: 'elpris' }))
  expect(bare.getByRole('button', { name: /Inloggning för/ }).elements()).toHaveLength(0)
})

test('not configured links to set it up', async () => {
  const onOpen = vi.fn()
  const screen = await renderWithProviders(
    tile({ ...ok, state: 'not_configured', code: 'not_configured' }, { onOpenCredentials: onOpen }),
  )
  await screen.getByRole('button', { name: m.charging_credentials_configure() }).click()
  expect(onOpen).toHaveBeenCalledOnce()
})

test('a refused sign-in links to update it and names the suspect fields', async () => {
  const screen = await renderWithProviders(
    tile(
      { ...ok, source: 'skoda', state: 'failing', code: 'forbidden',
        adminDetail: { lastErrorMessage: null, credentialExpiry: null, suspectFields: ['vin'] } as never },
      { onOpenCredentials: () => {} },
    ),
  )
  await expect.element(screen.getByRole('button', { name: m.charging_credentials_update() })).toBeVisible()
  await expect.element(screen.getByText(m.charging_credentials_suspect({ fields: 'VIN' }))).toBeVisible()
})

test('an outage that is not about credentials has no credentials link', async () => {
  const screen = await renderWithProviders(
    tile({ ...ok, state: 'failing', code: 'unreachable' }, { onOpenCredentials: () => {} }),
  )
  expect(screen.getByRole('button', { name: m.charging_credentials_update() }).elements()).toHaveLength(0)
})

test('the header keeps room for the key button', async () => {
  const screen = await renderWithProviders(tile(ok, { onOpenCredentials: () => {} }))
  const heading = screen.getByRole('heading', { level: 3 }).element()
  expect(heading.closest('[data-credentials-room]')).not.toBeNull()
})
```

(Layout itself is not testable here — no app CSS in browser tests; verify live in Task 6.)

- [ ] **Step 3:** Run → FAIL.

- [ ] **Step 4: Implement.**
  - `CredentialsButton.tsx` as specified above (`Tooltip` → `TooltipTrigger asChild` → `Button`; `TooltipContent` = label).
  - `SyncSourceTile`: when `onOpenCredentials` and `isCredentialSource(source)`: render
    `<div className="absolute top-3 right-3"><CredentialsButton source={source} label={m.charging_credentials_button({ source: name })} onClick={onOpenCredentials} /></div>`
    and mark the header row `data-credentials-room` with `pe-9 pointer-coarse:pe-12` (both the stacked and the row
    header live in that one div, so one padding covers both).
  - Under the message: `const link = health && onOpenCredentials ? credentialLink(health) : null`; the suspect line
    `health?.adminDetail?.suspectFields && isCredentialSource(source) ? suspectFieldsMessage(source, …) : null` in
    `text-destructive text-xs`; then, when `link`, a `<Button variant="link" size="xs" className="h-auto min-h-6 p-0" onClick={onOpenCredentials}>` with `configure` / `update` copy. Inside the details column (not the footer) so the footer keeps only sync + history.
  - `SyncSourcesPanel`: new prop; `onOpenCredentials={isCredentialSource(e.source) ? () => onOpenCredentials(e.source) : undefined}` (narrow inside a const).
  - Update `SyncSourcesPanel.browser.test.tsx`'s render helper to pass `onOpenCredentials={() => {}}`.

- [ ] **Step 5:** Tests (tile + panel) → PASS; `bun run typecheck` clean. The panel's `onOpenCredentials` is
  **optional** in this task (the route doesn't pass it yet); Task 5 makes it required.
- [ ] **Step 6: Commit** `feat(charging): add a key button and credential links to the tiles`

**Reviewers:** `code-reviewer` + reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

---

### Task 4: "Elnätsavtal" card

**Files:** Create `GridTariffCard.tsx`, `GridTariffCard.browser.test.tsx`; modify messages.

**Interfaces — Produces:**
```tsx
export function GridTariffCard(props: {
  facility: { origin: CredentialOrigin } | undefined   // status.sources.gridTariff.fields.facilityId
  unreadable: boolean
  onOpenCredentials: () => void
}): JSX.Element
```

- [ ] **Step 1: Messages:** `charging_grid_description` "Anläggnings-ID:t används för att se när elnätsbolaget finns i
  Eltariff-katalogen, så att nättariffen kan hämtas automatiskt." / "The facility ID is used to see when the grid company
  is in the Eltariff catalogue, so the grid tariff can be fetched automatically."; `charging_grid_status_stored`
  "Anläggnings-ID sparat i appen" / "Facility ID saved in the app"; `charging_grid_status_env` "Anläggnings-ID från
  miljövariabel" / "Facility ID from an environment variable"; `charging_grid_status_missing` "Anläggnings-ID saknas –
  månadskollen hoppas över" / "No facility ID – the monthly check is skipped"; `charging_grid_status_unreadable`
  "Det sparade anläggnings-ID:t går inte att läsa" / "The saved facility ID can't be read"; `charging_grid_cadence`
  "Kontrolleras den 1:a varje månad" / "Checked on the 1st of every month"; `charging_grid_button` "Ändra
  anläggnings-ID" / "Change facility ID".

- [ ] **Step 2: Failing tests:**

```tsx
import { expect, test, vi } from 'vitest'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { GridTariffCard } from './GridTariffCard'

test.each([
  ['stored', m.charging_grid_status_stored()],
  ['env', m.charging_grid_status_env()],
  ['missing', m.charging_grid_status_missing()],
] as const)('origin %s reads as its status', async (origin, text) => {
  const screen = await renderWithProviders(
    <GridTariffCard facility={{ origin }} unreadable={false} onOpenCredentials={() => {}} />,
  )
  await expect.element(screen.getByText(text)).toBeVisible()
  await expect.element(screen.getByText(m.charging_grid_cadence())).toBeVisible()
})

test('an unreadable row says so', async () => {
  const screen = await renderWithProviders(
    <GridTariffCard facility={{ origin: 'stored' }} unreadable onOpenCredentials={() => {}} />,
  )
  await expect.element(screen.getByText(m.charging_grid_status_unreadable())).toBeVisible()
})

test('the key button opens the dialog', async () => {
  const onOpen = vi.fn()
  const screen = await renderWithProviders(
    <GridTariffCard facility={{ origin: 'missing' }} unreadable={false} onOpenCredentials={onOpen} />,
  )
  await screen.getByRole('button', { name: m.charging_grid_button() }).click()
  expect(onOpen).toHaveBeenCalledOnce()
  await expect.element(screen.getByRole('heading', { name: m.charging_grid_title() })).toBeVisible()
})
```

- [ ] **Step 3:** Run → FAIL. **Step 4:** Implement: a `Card` (`relative px-5 py-5`, like the tile) with `<h2>` title
  (`font-heading font-semibold text-base`, `pe-9 pointer-coarse:pe-12`), description (`text-muted-foreground text-sm`),
  status line (`text-sm`; `text-destructive` when unreadable; `undefined` facility → nothing), the cadence
  (`text-muted-foreground text-xs`), and `CredentialsButton source="gridTariff" label={m.charging_grid_button()}` at
  `absolute top-3 right-3`. **Step 5:** PASS. **Step 6: Commit** `feat(charging): add the grid contract card`

**Reviewers:** `code-reviewer` + reviewer loading `web-design-guidelines`.

---

### Task 5: Settings route wiring

**Files:** Modify `src/routes/_authenticated/charging/settings.tsx`, `-settingsPage.browser.test.tsx`; make the panel's
`onOpenCredentials` required.

- [ ] **Step 1: Failing tests** (extend the seed with
  `qc.setQueryData(orpc.credentials.status.queryOptions().queryKey, STATUS as never)`, `STATUS` = Task 2's shape with
  everything `env`):

```tsx
test('the credential tiles have key buttons; elpris has none', async () => {
  const { screen } = await renderSettings('')
  for (const source of ['zaptec', 'skoda', 'emaldo'] as const)
    await expect.element(screen.getByRole('button', {
      name: m.charging_credentials_button({ source: integrationSourceName(source) }) })).toBeVisible()
  expect(screen.getByRole('button', {
    name: m.charging_credentials_button({ source: integrationSourceName('elpris') }) }).elements()).toHaveLength(0)
})

test('a key button opens the dialog through the URL', async () => {
  const { screen, router } = await renderSettings('')
  await screen.getByRole('button', { name: m.charging_credentials_button({ source: 'Škoda' }) }).click()
  await expect.element(screen.getByRole('dialog', { name: m.charging_credentials_title({ source: 'Škoda' }) })).toBeVisible()
  expect(router.state.location.search).toMatchObject({ dialog: 'credentials', source: 'skoda' })
})

test('not configured offers "Konfigurera", which opens the dialog', async () => {
  const { screen, router } = await renderSettings('', {
    prepare: (qc) => seedSourcesHealth(qc, { zaptec: { state: 'not_configured', code: 'not_configured' } }),
  })
  await screen.getByRole('button', { name: m.charging_credentials_configure() }).click()
  expect(router.state.location.search).toMatchObject({ dialog: 'credentials', source: 'zaptec' })
})

test('the grid card shows and opens the facility dialog', async () => {
  const { screen, router } = await renderSettings('')
  await expect.element(screen.getByText(m.charging_grid_status_env())).toBeVisible()
  await screen.getByRole('button', { name: m.charging_grid_button() }).click()
  expect(router.state.location.search).toMatchObject({ dialog: 'credentials', source: 'gridTariff' })
})

test('a credentials deep link opens that dialog', async () => {
  const { screen } = await renderSettings('?dialog=credentials&source=emaldo')
  await expect.element(screen.getByRole('dialog', { name: m.charging_credentials_title({ source: 'Emaldo' }) })).toBeVisible()
})

test('cleans a credentials link to a source without credentials', async () => {
  const { router } = await renderSettings('?dialog=credentials&source=elpris')
  await vi.waitFor(() => expect(router.state.location.search).not.toHaveProperty('dialog'))
})

test('cleans a history link to gridTariff', async () => {
  const { router } = await renderSettings('?dialog=syncRuns&source=gridTariff')
  await vi.waitFor(() => expect(router.state.location.search).not.toHaveProperty('dialog'))
})
```

(Match the file's existing assertions for cleaned search — it already has bad-link cleanup tests; reuse their form.)

- [ ] **Step 2:** Run → FAIL.

- [ ] **Step 3: Implement** in `settings.tsx`:
  - `dialog` enum gains `'credentials'`; `source: z.union([z.enum(INTEGRATION_SOURCES), z.enum(CREDENTIAL_SOURCES)]).optional().catch(undefined)`.
  - `const credentialsStatusQuery = orpc.credentials.status.queryOptions()`; add it to the loader's `critical`.
  - `const isIntegrationSource = (s: string | undefined): s is IntegrationSource => s !== undefined && (INTEGRATION_SOURCES as readonly string[]).includes(s)`.
  - `dialogUnavailable`: `dialog === 'syncRuns' ? !isIntegrationSource(source) : dialog === 'credentials' ? !(source && isCredentialSource(source)) : …existing tariff rule`.
  - Panel: `openSource={isOpen('syncRuns') && isIntegrationSource(source) ? source : undefined}`,
    `onOpenCredentials={(s) => open('credentials', { source: s })}`.
  - `const credentialsResult = useQuery(credentialsStatusQuery)`.
  - After the tariff card: `<LoadErrorAlert title={m.charging_credentials_error_title()} query={credentialsResult} />` and
    `<SectionSkeleton name="charging-grid" loading={firstLoadPending(credentialsResult)} fallbackHeight="9rem"><GridTariffCard facility={credentialsResult.data?.sources.gridTariff.fields.facilityId} unreadable={credentialsResult.data?.sources.gridTariff.unreadable ?? false} onOpenCredentials={() => open('credentials', { source: 'gridTariff' })} /></SectionSkeleton>`.
    Message `charging_credentials_error_title` "Inloggningsuppgifternas status kunde inte läsas" / "The credentials'
    status couldn't be read".
  - The dialog:
```tsx
const credentialsSource = isOpen('credentials') && source && isCredentialSource(source) ? source : undefined
<CredentialsDialog
  source={credentialsSource}
  open={credentialsSource !== undefined}
  onOpenChange={(o) => { if (!o) close() }}
  status={credentialsResult.data}
  suspectFields={credentialsSource && isIntegrationSource(credentialsSource)
    ? sourcesHealth?.[credentialsSource]?.adminDetail?.suspectFields : null}
  onChanged={(s) => { if (s !== 'gridTariff') syncNow.syncSource(s) }}
  // Opened by URL state: Radix has no trigger to return focus to.
  onCloseAutoFocus={(event) => {
    const opener = lastCredentialsSource.current
    const el = opener ? document.getElementById(credentialsButtonId(opener)) : null
    if (!el) return
    event.preventDefault()
    el.focus()
  }}
/>
```
    with `lastCredentialsSource = useRef<CredentialSource>()` updated whenever `credentialsSource` is defined.
  - Rename the local `runsSource` to `source` (it now serves two dialogs) and update its comment.
  - Make `SyncSourcesPanel`'s `onOpenCredentials` required.

- [ ] **Step 4:** Tests → PASS (whole file). **Step 5: Commit** `feat(charging): open credentials from the settings page`

**Reviewers:** `code-reviewer` + reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

---

### Task 6: Overview deep links, copy, runbook, skeletons

**Files:** `SettingsLink.tsx`, `SyncHealthAlert.tsx` (+test), `CredentialExpiryAlert.tsx` (+test), messages,
`src/emails/CredentialExpiryEmail.tsx` (+test), `docs/runbooks/skoda-api-key.md`, `src/bones/*`.

- [ ] **Step 1: Failing tests.**
  - `SyncHealthAlert.browser.test.tsx` (wrap in a router the way the existing settings-link test does):
    an admin's Škoda `auth_failed` alert with `settingsLink` has a link named `m.charging_credentials_update()` whose
    `href` contains `/charging/settings?dialog=credentials&source=skoda`; a Zaptec `not_configured` alert's link is
    `m.charging_credentials_configure()` with `source=zaptec`; an `unreachable` failure keeps
    `m.charging_settings_link()` to `/charging/settings` with no `dialog`; elpris never deep-links.
  - `CredentialExpiryAlert.browser.test.tsx`: the link is named `m.charging_credentials_replace_key()` and points at
    `?dialog=credentials&source=skoda`.
  - `CredentialExpiryEmail.test.tsx:52`: replace `expect(out).toContain('SKODA_API_KEY')` with
    `expect(out).not.toContain('SKODA_API_KEY')` (the GUI is the path now; the runbook keeps the env fallback).

- [ ] **Step 2:** Run → FAIL.

- [ ] **Step 3: Implement.**
  - `SettingsLink`: `search?: { dialog: 'tariffNew' } | { dialog: 'credentials'; source: CredentialSource }`.
  - `SyncHealthAlert`: `const credentials = link ? credentialLink(health) : null`; wherever `<SettingsLink />` renders,
    render `credentials ? <SettingsLink search={{ dialog: 'credentials', source: credentials.source }}>{credentials.kind === 'configure' ? m.charging_credentials_configure() : m.charging_credentials_update()}</SettingsLink> : <SettingsLink />` (one small local component `AlertSettingsLink`).
  - `CredentialExpiryAlert`: `<SettingsLink search={{ dialog: 'credentials', source: 'skoda' }}>{m.charging_credentials_replace_key()}</SettingsLink>`;
    message `charging_credentials_replace_key` "Byt nyckel" / "Replace key".
  - Copy (sv / en), replacing the env/redeploy instruction:
    - `charging_skoda_key_expiring_body` (both plural arms) and `_today`: "… Skapa en ny i MyŠkoda-appen och klistra
      in den under Laddning → Inställningar." / "… Create a new one in the MyŠkoda app and paste it under Charging →
      Settings."
    - `email_credential_expiry_body`: "API-nyckeln som Videbacken använder för att läsa bilens status går ut den
      {date}. Efter det räknas nya laddningar som vår bil, även om en gäst laddade. Skapa en ny nyckel i MyŠkoda-appen
      (https://go.skoda.eu/api-keys) och klistra in den under Laddning → Inställningar (nyckelknappen på Škoda). Synken
      körs direkt när du sparar." / "The API key Videbacken uses to read the car's status expires on {date}. After
      that, new charging sessions count as our car, even if a guest charged. Create a new key in the MyŠkoda app
      (https://go.skoda.eu/api-keys) and paste it under Charging → Settings (the key button on Škoda). The sync runs as
      soon as you save."
    - `CredentialExpiryEmail.tsx:12` comment: "(MyŠkoda, paste under Inställningar)".
  - Runbook `docs/runbooks/skoda-api-key.md` "Create or renew": 1. create the key (unchanged); 2. Laddning →
    Inställningar → the key button on Škoda → paste into "API-nyckel" (VIN and position only on first setup) → Spara;
    the Škoda sync runs; expect "Fungerar" and the new expiry date. **Fallback (no `CREDENTIALS_ENCRYPTION_KEY`, or
    the app is down):** the old env steps, noting a stored value overrides env field by field — remove the stored one
    first ("Ta bort sparade uppgifter") or the env change does nothing. Symptoms: `credentials_unreadable` → the
    encryption key is missing or changed: restore it, or re-enter every field. `forbidden` → the tile names the field
    (VIN, or key + VIN).
- [ ] **Step 4:** Tests → PASS. **Step 5: Commit** `feat(charging): link alerts into the credentials dialog`

**Reviewers:** `code-reviewer` + reviewer loading `react-email` + `email-best-practices` (the email copy) — the UI half
is the same link component already reviewed.

- [ ] **Step 6: Skeletons.** With the dev stack up and the dev server on :14610 (see `scripts/captureBones.ts`):
  `bun run bones:capture /charging/settings --force` (the tile gained a button; `charging-grid` is new). Check
  `test/bonesRegistry.test.ts` passes. Commit `chore(charging): recapture the settings page skeletons`.

---

### Task 7: Branch review, live check, docs, PR

- [ ] **Step 1: Branch review (Phase 5):** in parallel — `code-reviewer` (ADR adherence over the whole diff),
  a general correctness pass (`/code-review high`-style subagent), and a security pass (auth boundary: every new read
  is `credentials.status`, admin-only; no value can reach the DOM; the deep links don't render for members). Fix or
  rule on every finding.
- [ ] **Step 2: Pre-PR gate** (`docs/feature-workflow.md#pre-pr-gate`), sv/en key check included.
- [ ] **Step 3: Live (Phase 6)** at 1280, 820 and 390 px, signed in as an admin locally (Playwright + Mailpit magic
  link on :14610 if the Chrome extension is unavailable): key buttons and tooltips; a long name never runs under the
  key button (stacked and row headers); the dialog on desktop and as a bottom sheet on mobile; a save with a bad VIN
  (INVALID_FIELD on VIN only); a save → toast → the tile's "Synkar…" → result; remove → confirm → sync; the grid card;
  a deep link from the overview alert; with `CREDENTIALS_ENCRYPTION_KEY` unset, the missing-key alert. Use **fake**
  values locally — never the real Škoda key or Emaldo account (a login ends the owner's other sessions).
- [ ] **Step 4: Docs.** Roadmap row 3b: plan link, PR link, `PR open`. If any of "Decisions this plan makes" changed a
  spec decision, amend the spec's Step 3b section.
- [ ] **Step 5: PR** `feat(charging): set integration credentials from the settings page` with the template; list the
  six plan decisions under "Notes for the reviewer"; the checkpoint (roadmap §3) runs after merge.
