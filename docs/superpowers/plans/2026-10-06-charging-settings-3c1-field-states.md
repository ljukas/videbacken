# Charging settings step 3c-1 — credential field states Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the credentials dialog, a field no longer shows an empty input with a grey line under it. Its label gets a
neutral badge for where the value comes from, followed by a summary line (save date, or the env var it uses) and a
"Byt" / "Ange i appen" / "Välj på kartan" button that reveals the input. Hints move above inputs, the remove confirm
says what happens next, and the VIN hint points at the MyŠkoda app.

**Architecture:**
- A new `CredentialFieldRow` renders one field in one of two states:
  - *closed:* badge, summary and a reveal button;
  - *open:* badge, hints, input and error.
- The dialog keeps which fields are open as UI state. Field values stay in `useAppForm` (ADR-0005), and closing a
  field clears its value.
- The field → env var map moves into the client-safe vocabulary, so the client can name variables. Values never move.
- `credentials.status` gains a names-only `envSet` flag per field. The remove confirm uses it to say whether the app
  falls back to env.

**Tech Stack:** React 19, `@tanstack/react-form` (`useAppForm`), shadcn/Radix, Paraglide, oRPC, Drizzle (service
test), Vitest (node + browser), bun.

**Spec:** `docs/superpowers/specs/2026-10-05-charging-settings-design.md` § "Step 3c — credentials UX" → "3c-1".
- Mockup (owner-approved 2026-10-06): https://claude.ai/artifact/UyTQkEAKAemBHbAThriaoM, artboards 1-6 (rows "3c-1"
  and the phone sheet).
- ADR-0026 (and its 2026-10-06 amendment, which is for 3c-2). Roadmap
  `docs/superpowers/roadmaps/2026-10-05-charging-settings.md`.

## Global Constraints

- **No value ever reaches the client.** `status` returns origins, dates and booleans only. Inputs are never
  pre-filled.
- Secret inputs keep `type="password"` and `autoComplete="new-password"`, the password-manager opt-outs, and the
  namespaced ids `credential-<source>-<field>`. Text inputs keep `autoComplete="off"`.
- Client code may only `import type` from services. Shared vocabulary lives in `~/lib/integrationCredentials` (no
  `db`, no `process.env`).
- Every string goes in `messages/sv.json` (the source of truth) and `messages/en.json` (key-complete). Run
  `bun run i18n:compile` after editing them.
- Forms use `useAppForm`, with no `useState` for field *values*. Which fields are open is UI state and may use
  `useState`.
- Red text and borders are for errors only. Badges are real text, so a state never relies on colour alone.
- Every reveal button has its own accessible name ("Byt VIN", "Ange användarnamn i appen", "Välj laddboxens position
  på kartan").
- Phones keep ADR-0013's bottom sheet (issue #107 is out of scope). Touch targets are 44 px on coarse pointers.
- Conventional commits, ≤72 characters, one hat per commit. Trailer:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Never run two vitest processes at once, and reviewers never run vitest. One-shot browser runs use
  `bunx vitest run --project browser <path>`; node runs use `bunx vitest run <path>`. Never `test:components` (it
  watches).

## Copy (verbatim, sv / en)

> **As built:** the `*_label` keys below were replaced by one `charging_credentials_field_action_label`
> ("{action}, {field}", WCAG 2.5.3: the visible text starts the name). The spec's "As built (3c-1)" is the record.

| key | sv | en |
|---|---|---|
| `charging_credentials_badge_stored` | Sparad | Saved |
| `charging_credentials_badge_env` | Miljövariabel | Environment variable |
| `charging_credentials_badge_missing` | Inte angiven | Not set |
| `charging_credentials_badge_unreadable` | Kan inte läsas | Can't be read |
| `charging_credentials_origin_stored` (changed) | Sparad i appen {date} | Saved in the app {date} |
| `charging_credentials_using_env` | Används från | Using |
| `charging_credentials_replace` | Byt | Replace |
| `charging_credentials_replace_label` | Byt {field} | Replace {field} |
| `charging_credentials_set_in_app` | Ange i appen | Set in the app |
| `charging_credentials_set_in_app_label` | Ange {field} i appen | Set {field} in the app |
| `charging_credentials_choose_on_map` | Välj på kartan | Choose on the map |
| `charging_credentials_change_on_map` | Ändra på kartan | Change on the map |
| `charging_credentials_map_label` | Välj laddboxens position på kartan | Choose the charger's position on the map |
| `charging_credentials_close_field` | Avbryt | Cancel |
| `charging_credentials_close_field_label` | Avbryt ändringen av {field} | Cancel changing {field} |
| `charging_credentials_keeps_current` | Det nuvarande värdet används tills du sparar. | The current value stays in use until you save. |
| `charging_credentials_overrides_env` | Ett värde som sparas här går före miljövariabeln. | A value saved here overrides the environment variable. |
| `charging_credentials_hint_vin` (changed) | 17 tecken (inte I, O eller Q). Finns i MyŠkoda-appen under Inspect → Car details. | 17 characters (no I, O or Q). In the MyŠkoda app under Inspect → Car details. |
| `charging_credentials_dialog_description` | Uppgifterna som Videbacken använder för att hämta data från {source}. | The details Videbacken uses to fetch data from {source}. |
| `charging_credentials_dialog_description_grid` | Anläggnings-ID:t som månadskollen av elnätstariffen använder. | The facility ID the monthly grid-tariff check uses. |
| `charging_credentials_remove_confirm` (changed) | De sparade uppgifterna för {source} ({fields}) tas bort. | The saved details for {source} ({fields}) are removed. |
| `charging_credentials_remove_confirm_grid` (changed) | Det sparade anläggnings-ID:t tas bort. | The saved facility ID is removed. |
| `charging_credentials_remove_falls_back` | Appen använder miljövariablerna igen. | The app falls back to the environment variables. |
| `charging_credentials_remove_falls_back_one` | Appen använder miljövariabeln igen. | The app falls back to the environment variable. |
| `charging_credentials_remove_stops` | Källan slutar synka. | This source stops syncing. |
| `charging_credentials_remove_stops_grid` | Månadskollen hoppas över. | The monthly check is skipped. |
| `charging_grid_status_env` (changed) | Anläggnings-ID från | Facility ID from |
| `common_close` (add only if no such key exists; grep first) | Stäng | Close |

**Removed keys:** `charging_credentials_description` ("Lämna ett fält tomt…"), `charging_credentials_origin_env` and
`charging_credentials_origin_missing`. Drop each once nothing uses it, and grep before deleting.

## Review Focus

1. **A closed field must never be sent**, even when it had a value typed and then "Avbryt" was pressed: closing clears
   the value. Test: Task 3, "Avbryt clears what was typed, and the field is not sent".
2. **`REENTER_ALL_FIELDS` or `INVALID_FIELD` naming a field that is closed** must open that field and show the error
   on it. Otherwise the admin sees an error on nothing. Test: Task 3, "a server error opens the field it names".
3. **The encryption key is missing.** Reveal buttons are disabled with the alert as their description, missing fields'
   inputs stay disabled, focus starts on "Stäng", and "Ta bort sparade uppgifter" still works. Test: Task 3,
   "missing key: reveal buttons disabled, remove still works".
4. **The status read failed (`status` undefined).** Origins are unknown, so every field opens, as before, and none
   shows a badge. Test: Task 3, "unknown status opens every field without badges".
5. **The remove confirm when a stored field also has an env var** (`envSet`, while the origin says `stored`) must say
   "falls back". With no env var anywhere, it must say "stops syncing". Test: Task 4, both cases.

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `src/lib/integrationCredentials.ts` | modify | `CREDENTIAL_ENV_VARS` (field → env var *name*), client-safe |
| `src/lib/credentials/env.ts` | modify | import the map from the vocabulary; keep `envCredential` |
| `src/lib/services/integrationCredential/integrationCredential.ts` (+ test) | modify | `status()` adds `envSet: boolean` per field |
| `src/lib/integrationCredentialsMessage.ts` (+ test) | modify | `credentialFieldList(source, fields)` (sv "API-nyckel och VIN") |
| `messages/{sv,en}.json` | modify | the copy table above |
| `src/components/evCharging/CredentialFieldRow.tsx` | create | one field row: closed (badge, summary, reveal) or open (badge, hints, input) |
| `src/components/evCharging/CredentialsDialog.tsx` (+ test) | modify | open-field state, rows, footer Stäng/Avbryt, remove-confirm consequence |
| `src/components/evCharging/GridTariffCard.tsx` (+ test) | modify | env status names `GRID_FACILITY_ID` |
| spec, roadmap, `src/bones/charging-grid.bones.json` | modify | as-built notes, row 3c-1, recapture if the card's DOM changed |

---

### Task 0: Check main still matches the spec

- [ ] **Step 1:** Confirm the starting point on branch `feat/charging-credentials-ux` (it already holds the 3c spec
  commits). Run:

```bash
git log --oneline -6
grep -n "CREDENTIAL_ENV" src/lib/credentials/env.ts
grep -n "envCredential(source, field)" src/lib/services/integrationCredential/integrationCredential.ts
grep -n "originLine\|charging_credentials_description" src/components/evCharging/CredentialsDialog.tsx
```

  Expected: `CREDENTIAL_ENV` in `env.ts`, `status()` computing `env` origin with `envCredential`, and the dialog's
  `originLine`. Any mismatch → stop and amend this plan.

---

### Task 1: Server — env var names client-safe, `envSet` in status

**Files:** `src/lib/integrationCredentials.ts`, `src/lib/credentials/env.ts`,
`src/lib/services/integrationCredential/integrationCredential.ts`, its `.test.ts`, and any test pinning
`CREDENTIAL_ENV` (grep).

**Interfaces — Produces:**
- `CREDENTIAL_ENV_VARS: { [S in CredentialSource]: Record<CredentialField<S>, string> }` in
  `~/lib/integrationCredentials`.
- `CredentialSourceStatus<S>['fields'][f]` becomes `{ origin: CredentialOrigin; envSet: boolean }`.

- [ ] **Step 1: Failing test.** In the service test's `describe('status')`, add:

```ts
test('envSet says whether an env var exists, even behind a stored value', async () => {
  vi.stubEnv('SKODA_API_KEY', 'env-key')
  vi.stubEnv('SKODA_VIN', '')
  await set('skoda', { apiKey: 'stored-key', vin: 'TMBJJ7NE8L0123456' }, null)
  const { sources } = await status()
  expect(sources.skoda.fields.apiKey).toEqual({ origin: 'stored', envSet: true })
  expect(sources.skoda.fields.vin).toEqual({ origin: 'stored', envSet: false })
  expect(sources.skoda.fields.homeCoordinates.envSet).toBe(false)
})
```

  Follow the file's existing patterns for env stubbing, `set`'s third argument (userId) and the encryption-key
  setup. Copy them from the neighbouring status tests.

- [ ] **Step 2:** Run `bunx vitest run src/lib/services/integrationCredential/integrationCredential.test.ts`. Expect
  it to FAIL (no `envSet`).

- [ ] **Step 3: Implement.**
  - **Vocabulary.** Move the literal map from `env.ts` into `integrationCredentials.ts`:

```ts
/** The env var each field falls back to (ADR-0026). Names only — client-safe; values are read server-side. */
export const CREDENTIAL_ENV_VARS = {
  zaptec: { username: 'ZAPTEC_USERNAME', password: 'ZAPTEC_PASSWORD' },
  skoda: { apiKey: 'SKODA_API_KEY', vin: 'SKODA_VIN', homeCoordinates: 'SKODA_HOME_COORDINATES' },
  emaldo: {
    user: 'EMALDO_USER',
    password: 'EMALDO_PASSWORD',
    appId: 'EMALDO_APP_ID',
    appSecret: 'EMALDO_APP_SECRET',
  },
  gridTariff: { facilityId: 'GRID_FACILITY_ID' },
} as const satisfies { [S in CredentialSource]: Record<CredentialField<S>, string> }
```

  - **`env.ts`.** `import { CREDENTIAL_ENV_VARS } from '~/lib/integrationCredentials'` and keep exporting
    `CREDENTIAL_ENV = CREDENTIAL_ENV_VARS` for existing importers, or update them; grep for `CREDENTIAL_ENV`.
    `envCredential` is unchanged.
  - **`status()`.** Per field:

```ts
const envSet = envCredential(source, field) !== undefined
const origin: CredentialOrigin = stored.has(field) ? 'stored' : envSet ? 'env' : 'missing'
return [field, { origin, envSet }]
```

    Update the `CredentialSourceStatus` type accordingly.
  - Update any existing test that asserts `toEqual({ origin: … })` on a status field.

- [ ] **Step 4:** Run the service test, `bun run typecheck` (the client's `CredentialStatus` type follows through
  oRPC) and `bun run check:ci`. Expect them to PASS.
- [ ] **Step 5: Commit** `feat(charging): tell admins which env vars back each credential`.

**Reviewers:** `code-reviewer` + `test-completeness`.

---

### Task 2: Copy layer

**Files:** `messages/{sv,en}.json`, `src/lib/integrationCredentialsMessage.ts` (+ `.test.ts`).

**Interfaces — Produces:**
- `credentialFieldList<S extends CredentialSource>(source: S, fields: readonly CredentialField<S>[]): string`. Labels
  in vocabulary order, joined with `Intl.ListFormat` conjunction in the page locale.
- `suspectFieldsMessage` reuses it.

- [ ] **Step 1:** Add every key in the copy table (sv + en). Change the four "(changed)" ones. Don't delete the
  removed keys yet: Task 3 drops their last users and deletes them.
- [ ] **Step 2: Failing test.**

```ts
test('credentialFieldList joins labels in vocabulary order', () => {
  expect(credentialFieldList('skoda', ['vin', 'apiKey'])).toBe('API-nyckel och VIN')
  expect(credentialFieldList('emaldo', ['appId', 'user', 'password'])).toBe('Användarnamn, Lösenord och App-id')
})
```

- [ ] **Step 3:** Implement `credentialFieldList`, and refactor `suspectFieldsMessage` to use it. Its tests must stay
  green.
- [ ] **Step 4:** Run `bun run i18n:compile && bunx vitest run src/lib/integrationCredentialsMessage.test.ts`, then
  `bun run check:ci`. Expect them to PASS.
- [ ] **Step 5: Commit** `feat(charging): add credential field-state copy`.

**Reviewers:** `code-reviewer` + a reviewer loading `web-design-guidelines` (copy, sv/en tone, consistency with the
mockup).

---

### Task 3: Field rows — closed/open states in the dialog

**Files:** create `src/components/evCharging/CredentialFieldRow.tsx`; modify `CredentialsDialog.tsx` and
`CredentialsDialog.browser.test.tsx`.

**Interfaces:**
- **Consumes:** Task 1's `envSet` and `CREDENTIAL_ENV_VARS`; Task 2's keys.
- **Produces (internal to the dialog):**

```tsx
type FieldState = 'stored' | 'env' | 'missing' | 'unreadable' | 'unknown'
export function CredentialFieldRow(props: {
  source: CredentialSource
  field: CredentialFieldName
  state: FieldState
  /** Save date for 'stored'. */
  savedAt: Date | null
  open: boolean
  /** Closed rows only: reveal the input (focus moves to it). */
  onOpen: () => void
  /** Open rows that may close again (stored/env): hide and clear the input. */
  onClose?: () => void
  suspect: boolean
  /** Disabled reveal button + input (encryption key missing), described by this id. */
  disabledBy?: string
  /** The bound input (form.AppField → field.TextField), rendered only when open. */
  children: React.ReactNode
}): JSX.Element
```

**Behaviour:**
- **State per field:**
  - status undefined → `unknown`;
  - source unreadable → `unreadable`;
  - otherwise the field's `origin`.
- **Initially open:** `missing`, `unreadable` and `unknown`. Closed: `stored` and `env`.
- **Header row:** the label, then the badge, using the copy keys and the mockup's look:
  - neutral outline pill for stored/env;
  - dashed pill for missing;
  - amber pill with an icon for unreadable;
  - no badge for unknown.
- **Avbryt link:** on the right of the header row when the field is open *and* its state is stored or env. Its
  accessible name is `charging_credentials_close_field_label`.
- **Suspect line:** under the header, in red with an icon, using the existing `charging_credentials_field_suspect`.
- **Closed body:** a summary on the left and the reveal button on the right.
  - **stored:** "Sparad i appen {date}" (`formatDate`) with "Byt" (name "Byt {label}").
  - **env:** "Används från `<code>{ENV_VAR}</code>`" with "Ange i appen" (name "Ange {label} i appen").
  - **`skoda.homeCoordinates`:** the button is "Ändra på kartan" (stored) or "Välj på kartan" (env), and its name is
    `charging_credentials_map_label`. In 3c-1 it opens the "lat,lon" input; 3c-2 swaps in the picker.
- **Open body, top to bottom:**
  1. the format hint (`credentialFieldHint`);
  2. for stored/env, `charging_credentials_keeps_current`;
  3. for env, `charging_credentials_overrides_env` as well;
  4. the input (`children`);
  5. the error, from `FieldError` in `TextField`.
  - The hints sit between the label and the input. `TextField` renders `description` *below* the input, so add an
    optional `descriptionPlacement: 'above' | 'below'` prop (default `'below'`, so other forms are unchanged). The row
    passes `'above'`. `aria-describedby` order stays hint, then error.
  - The visible label is the row's header. Pass the label to `TextField` and render it once: give `TextField` an
    optional `hideLabel` (sr-only), or lift the label into the row and give the input `aria-labelledby`. Either way
    the input's accessible name must equal the field label, and a test must pin it.
- **Opening a field** sets it open and focuses its input once rendered (`document.getElementById(inputId)` in an
  effect keyed on the open set).
- **Closing a field:** `form.setFieldValue(f, '')`, forget its server error, then set it closed.
- **Server errors** (`showFieldErrors`) add every named field to the open set before marking it touched and focusing
  it.
- **Submit:** unchanged, because only non-blank values are sent and closed fields are blank.
- **Footer:** with no field open, the cancel button reads "Stäng" (`common_close`) and Spara is disabled. With one or
  more open it reads "Avbryt" (`common_cancel`) and Spara follows today's rules.
- **Encryption key missing:**
  - the reveal buttons are `disabled` with `aria-describedby` set to the alert id;
  - open inputs stay disabled, as today;
  - focus starts on the cancel button, as today.
- **Dialog description:** `charging_credentials_dialog_description({ source })`, or the `_grid` variant. Delete the
  `charging_credentials_description`, `charging_credentials_origin_env` and `charging_credentials_origin_missing` keys
  once grep shows no users. The Škoda help line and link stay above the rows.

- [ ] **Step 1: Failing tests.** Add the tests below. Then update the existing tests that type into a stored or env
  field so they click its reveal button first. Use the file's `status()` fixture (`apiKey` stored, `vin` env,
  `homeCoordinates` missing) and add `envSet` to it.

```tsx
test('stored and env fields start closed with badge, summary and a named reveal button', async () => {
  const { screen } = await renderWithProviders(dialog())
  await expect.element(screen.getByText(m.charging_credentials_badge_stored())).toBeVisible()
  await expect.element(screen.getByText(m.charging_credentials_badge_env())).toBeVisible()
  await expect.element(screen.getByText('SKODA_VIN')).toBeVisible()
  await expect.element(screen.getByRole('button', { name: 'Byt API-nyckel' })).toBeVisible()
  await expect.element(screen.getByRole('button', { name: 'Ange VIN i appen' })).toBeVisible()
  expect(screen.getByLabelText('API-nyckel').elements()).toHaveLength(0)
  // Missing: input shown directly, no reveal button.
  await expect.element(screen.getByLabelText('Laddboxens position')).toBeVisible()
})

test('the home position reveal button speaks of the map', async () => {
  const { screen } = await renderWithProviders(
    dialog({ status: status({}, { fields: { apiKey: { origin: 'stored', envSet: false }, vin: { origin: 'stored', envSet: false }, homeCoordinates: { origin: 'env', envSet: true } } }) }),
  )
  const map = screen.getByRole('button', { name: m.charging_credentials_map_label() })
  await expect.element(map).toHaveTextContent(m.charging_credentials_choose_on_map())
})

test('Byt reveals and focuses the input with its hints above it', async () => {
  const { screen } = await renderWithProviders(dialog())
  await screen.getByRole('button', { name: 'Byt API-nyckel' }).click()
  const input = screen.getByLabelText('API-nyckel')
  await expect.element(input).toHaveFocus()
  await expect.element(screen.getByText(m.charging_credentials_keeps_current())).toBeVisible()
  // Hint precedes the input in the DOM.
  const hint = screen.getByText(m.charging_credentials_keeps_current()).element()
  expect(hint.compareDocumentPosition(input.element()) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
})

test('an env field, once opened, says a saved value overrides the variable', async () => {
  const { screen } = await renderWithProviders(dialog())
  await screen.getByRole('button', { name: 'Ange VIN i appen' }).click()
  await expect.element(screen.getByText(m.charging_credentials_overrides_env())).toBeVisible()
})

test('Avbryt clears what was typed, and the field is not sent', async () => {
  const { screen } = await renderWithProviders(dialog())
  await screen.getByRole('button', { name: 'Byt API-nyckel' }).click()
  await screen.getByLabelText('API-nyckel').fill('typed-then-abandoned')
  await screen.getByRole('button', { name: m.charging_credentials_close_field_label({ field: 'API-nyckel' }) }).click()
  await screen.getByLabelText('Laddboxens position').fill('59.33,18.07')
  await screen.getByRole('button', { name: m.common_save(), exact: true }).click()
  await vi.waitFor(() => expect(setFn).toHaveBeenCalled())
  expect(setFn.mock.calls[0][0]).toEqual({ source: 'skoda', fields: { homeCoordinates: '59.33,18.07' } })
})

test('a server error opens the field it names', async () => {
  setFn.mockRejectedValue(new ORPCError('REENTER_ALL_FIELDS', { defined: true, data: { fields: ['apiKey'] } }))
  const { screen } = await renderWithProviders(dialog())
  await screen.getByLabelText('Laddboxens position').fill('59.33,18.07')
  await screen.getByRole('button', { name: m.common_save(), exact: true }).click()
  await expect.element(screen.getByLabelText('API-nyckel')).toBeVisible()
  await expect.element(screen.getByText(m.charging_credentials_reenter_field())).toBeVisible()
})

test('with nothing open the footer says Stäng and Spara is disabled', async () => {
  const allSet = status({}, { fields: { apiKey: { origin: 'stored', envSet: false }, vin: { origin: 'stored', envSet: false }, homeCoordinates: { origin: 'env', envSet: true } } })
  const { screen } = await renderWithProviders(dialog({ status: allSet }))
  await expect.element(screen.getByRole('button', { name: m.common_close() })).toBeVisible()
  await expect.element(screen.getByRole('button', { name: m.common_save(), exact: true })).toBeDisabled()
  await screen.getByRole('button', { name: 'Byt VIN' }).click()
  await expect.element(screen.getByRole('button', { name: m.common_cancel() })).toBeVisible()
  await expect.element(screen.getByRole('button', { name: m.common_save(), exact: true })).toBeEnabled()
})

test('unknown status opens every field without badges', async () => {
  const { screen } = await renderWithProviders(dialog({ status: undefined }))
  for (const name of ['API-nyckel', 'VIN', 'Laddboxens position'])
    await expect.element(screen.getByLabelText(name)).toBeVisible()
  expect(screen.getByText(m.charging_credentials_badge_stored()).elements()).toHaveLength(0)
})

test('unreadable opens every field with the amber badge', async () => {
  const { screen } = await renderWithProviders(dialog({ status: status({}, { unreadable: true }) }))
  expect(screen.getByText(m.charging_credentials_badge_unreadable()).elements()).toHaveLength(3)
  await expect.element(screen.getByLabelText('API-nyckel')).toBeVisible()
})

test('missing key: reveal buttons disabled, remove still works', async () => {
  const { screen } = await renderWithProviders(dialog({ status: status({ encryptionKeyConfigured: false }) }))
  await expect.element(screen.getByRole('button', { name: 'Byt API-nyckel' })).toBeDisabled()
  await screen.getByRole('button', { name: m.charging_credentials_remove() }).click()
  await screen.getByRole('alertdialog').getByRole('button', { name: m.charging_credentials_remove() }).click()
  await vi.waitFor(() => expect(clearFn).toHaveBeenCalled())
})

test('the input keeps the field label as its accessible name', async () => {
  const { screen } = await renderWithProviders(dialog())
  await screen.getByRole('button', { name: 'Byt API-nyckel' }).click()
  // A password input has no textbox role; the accessible name is what matters.
  await expect.element(screen.getByLabelText('API-nyckel')).toHaveAccessibleName('API-nyckel')
  // The label text is rendered once (the row header), not twice.
  expect(screen.getByText('API-nyckel', { exact: true }).elements()).toHaveLength(1)
})
```

  - Adapt `status()` in the test file to the `{ origin, envSet }` shape. The `status({}, { fields })` override form
    above assumes the helper merges a `fields` override into Škoda; extend the helper if it doesn't.
  - Remove the tests made obsolete by the new pattern: "each field shows its origin, and every input starts empty" is
    replaced by the first test above. Then re-express "unreadable: every field says it cannot be read" through the
    badge.
  - Keep every other test's intent: secret inputs, namespaced ids, focus on errors, the dismissal guard, method=post
    and invalidation.

- [ ] **Step 2:** Run `bunx vitest run --project browser src/components/evCharging/CredentialsDialog.browser.test.tsx`.
  Expect the new tests to FAIL.
- [ ] **Step 3: Implement** `CredentialFieldRow` and wire it into `CredentialsForm` as described in "Behaviour". The
  open set is `useState<ReadonlySet<CredentialFieldName>>(() => initialOpen(fields, states))`.
- [ ] **Step 4:** Run the dialog test file, `src/routes/_authenticated/charging/-settingsPage.browser.test.tsx` (it
  opens the dialog) and the form tests that use `TextField` (grep `src/components/form`). Then `bun run i18n:compile`,
  `bun run typecheck` and `bun run check:ci`. Expect them to PASS.
- [ ] **Step 5: Commit** `feat(charging): show where each credential comes from`.

**Reviewers:** `code-reviewer` + a reviewer loading `web-design-guidelines` and `vercel-react-best-practices`.

---

### Task 4: Remove confirm — what gets removed and what happens next

**Files:** `CredentialsDialog.tsx` and its test.

**Behaviour:**
- **The description names the stored fields:**
  - `charging_credentials_remove_confirm({ source, fields: credentialFieldList(source, storedFields) })`;
  - for the grid, `charging_credentials_remove_confirm_grid()`.
- **Then a second line (`<p>`, in `font-medium`) says what happens next:**
  - any field of the source has `envSet` → `remove_falls_back`, or `_falls_back_one` for the grid (one field);
  - no field has `envSet` → `remove_stops`, or `remove_stops_grid` for the grid.
- **An unreadable source** (stored fields unknown) names no fields: use the source-only wording,
  `charging_credentials_remove_confirm` with `fields` = every field of the source.

- [ ] **Step 1: Failing tests:**

```tsx
test('the remove confirm names the saved fields and says the app falls back to env', async () => {
  const s = status({}, { fields: { apiKey: { origin: 'stored', envSet: true }, vin: { origin: 'stored', envSet: false }, homeCoordinates: { origin: 'missing', envSet: false } } })
  const { screen } = await renderWithProviders(dialog({ status: s }))
  await screen.getByRole('button', { name: m.charging_credentials_remove() }).click()
  const confirm = screen.getByRole('alertdialog')
  await expect.element(confirm.getByText(m.charging_credentials_remove_confirm({ source: 'Škoda', fields: 'API-nyckel och VIN' }))).toBeVisible()
  await expect.element(confirm.getByText(m.charging_credentials_remove_falls_back())).toBeVisible()
})

test('with no env vars the remove confirm says the source stops syncing', async () => {
  const s = status({}, { fields: { apiKey: { origin: 'stored', envSet: false }, vin: { origin: 'stored', envSet: false }, homeCoordinates: { origin: 'missing', envSet: false } } })
  const { screen } = await renderWithProviders(dialog({ status: s }))
  await screen.getByRole('button', { name: m.charging_credentials_remove() }).click()
  await expect.element(screen.getByRole('alertdialog').getByText(m.charging_credentials_remove_stops())).toBeVisible()
})

test('the grid remove confirm says the monthly check is skipped without env', async () => {
  const base = status()
  const s = {
    ...base,
    sources: {
      ...base.sources,
      gridTariff: { fields: { facilityId: { origin: 'stored', envSet: false } }, updatedAt: SAVED, unreadable: false },
    },
  } as CredentialStatus
  const { screen } = await renderWithProviders(dialog({ source: 'gridTariff', status: s }))
  await screen.getByRole('button', { name: m.charging_credentials_remove() }).click()
  const confirm = screen.getByRole('alertdialog')
  await expect.element(confirm.getByText(m.charging_credentials_remove_confirm_grid())).toBeVisible()
  await expect.element(confirm.getByText(m.charging_credentials_remove_stops_grid())).toBeVisible()
})
```

- [ ] **Step 2:** Run the tests and expect them to FAIL. **Step 3:** Implement. **Step 4:** Run the tests and
  `check:ci`; expect PASS. **Step 5: Commit** `feat(charging): say what removing credentials leads to`.

**Reviewers:** `code-reviewer` + a reviewer loading `web-design-guidelines`.

---

### Task 5: Grid card names its env var; docs; skeletons

**Files:** `GridTariffCard.tsx` (+ test), the spec, the roadmap, and `src/bones/`.

- [ ] **Step 1: Failing test** (`GridTariffCard.browser.test.tsx`). For the env origin, the status reads
  "Anläggnings-ID från" followed by a `<code>` element with `GRID_FACILITY_ID`:

```tsx
await expect.element(screen.getByText('GRID_FACILITY_ID')).toBeVisible()
```

- [ ] **Step 2:** Implement it as `{m.charging_grid_status_env()} <code>{CREDENTIAL_ENV_VARS.gridTariff.facilityId}</code>`,
  styled like the dialog's `code`. Then run the test, `check:ci` and commit
  `feat(charging): name the grid facility ID's env var`.
- [ ] **Step 3: Docs.**
  - In the spec's 3c-1 section, record any decision the build changed: the TextField props added, and `envSet` in
    `status`.
  - Roadmap row 3c-1: plan link and `in progress`.
  - Commit `docs(charging): record step 3c-1 as built`.
- [ ] **Step 4 (controller): Skeletons and the live check.**
  - The grid card's DOM changed, so run `bun run bones:capture /charging/settings --force` and
    `bunx vitest run test/bonesRegistry.test.ts`, then commit `chore(charging): recapture the settings skeletons`.
  - Live check at 1280, 820 and 390 px with a throwaway encryption key, fake Zaptec and blank Škoda/Emaldo env:
    - each origin's badge and summary;
    - Byt → input → Avbryt;
    - a server error on a closed field;
    - footer Stäng/Avbryt;
    - the remove confirm in both variants;
    - Škoda's position button reading "Välj på kartan".

### Task 6: Branch review, pre-PR gate, PR

- [ ] **Branch review (Phase 5):**
  - `code-reviewer` (ADRs 0002, 0005, 0013, 0016, 0026);
  - `test-completeness` (the service change);
  - a whole-branch correctness review;
  - a security pass. Check that `envSet` and the env var names can't reveal a value; they're names only.
- [ ] **Pre-PR gate** (`docs/feature-workflow.md#pre-pr-gate`), with the sv/en key check.
- [ ] **PR** `feat(charging): show where each credential comes from`.
  - Note that the branch also carries the 3c spec and the ADR-0026 amendment (2026-10-06) for 3c-2, as docs only.
  - Link the mockup and issue #107.
  - Fill in the roadmap row's PR link.
