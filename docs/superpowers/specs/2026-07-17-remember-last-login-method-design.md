# Remember last-used login method

**Date:** 2026-07-17
**Status:** Approved (v2, post adversarial review) — ready for implementation plan

## Problem

The login screen shows a "Välkommen tillbaka" card (`WelcomeBackCard`) for a
returning visitor whose email we remember. That card always renders the
magic-link button as the primary (filled) action and Google as the secondary
(outline) option — a leftover from when the template only had magic-link /
passkey.

Now that Google OAuth exists, a visitor whose last successful sign-in was via
Google is still shown magic-link as the primary button. The card should instead
promote whichever method the visitor last **successfully** used.

Scope is the **welcome-back card only**. The fresh login form (`LoginFormCard`,
shown for a new or "log in as someone else" email) keeps its current order —
the remembered method is bound to the remembered email, which is meaningless
for "someone else".

## Decisions

From brainstorming:
- **Detection: on successful sign-in only** (not on click/attempt).
- **Scope: welcome-back card only.**
- **Primary style: reorder + emphasize** — the remembered method moves to the
  top and takes the filled (`variant="default"`) style; the other becomes the
  outline secondary below the "ELLER" divider.

Revised after two adversarial reviews (see "Review outcomes" below):
- **Storage/detection: adopt Better Auth's official `lastLoginMethod` plugin**
  rather than hand-rolling detection. The plugin owns the (version-sensitive)
  endpoint-path → method mapping, so we don't track Better Auth internals.
- **Add a localized "Senast använd" / "Last used" caption** on the promoted
  button, associated via `aria-describedby`, so the emphasis is programmatic
  (screen-reader perceivable), not fill-and-position only.

## Design

### 1. Detection + storage — the `lastLoginMethod` plugin

Register the plugin in `src/lib/auth.ts` (barrel import, matching the existing
`admin` / `magicLink` imports):

```ts
import { admin, lastLoginMethod, magicLink } from 'better-auth/plugins'
// ...
plugins: [
  magicLink({ /* unchanged */ }),
  admin(),
  lastLoginMethod({ maxAge: 60 * 60 * 24 * 365 }), // match the 1-year welcome-back email cookie
  tanstackStartCookies(),
],
```

What the plugin does (verified against installed source,
`node_modules/better-auth/dist/plugins/last-login-method/index.mjs`, v1.6.23):

- A `hooks.after` runs after every auth endpoint. It resolves the method from
  `ctx.path` and **only writes the cookie when the response just set the session
  token** (i.e., an actual sign-in occurred).
- Its `defaultResolveMethod` already covers both our flows — no
  `customResolveMethod` needed:
  - `/callback/:id` (and `/oauth2/callback/:id`) → `ctx.params?.id` → `'google'`.
  - `/magic-link/verify` → `'magic-link'`.
- Writes cookie `better-auth.last_used_login_method` with the **plain method
  string** as value (`ctx.setCookie`, unsigned), `httpOnly: false`, other
  attributes inherited from the session-token cookie (`sameSite`/`secure`/path).
- `storeInDatabase` defaults to `false` → `schema` is `undefined` → **no DB
  field, no migration, and `bun run auth:schema` stays a no-op** (do not run it).

Because the plugin gates on "a session token was just set", the following all
resolve to `null` and correctly write nothing: admin impersonation
(`/admin/impersonate-user`), cookie-cache refresh, and `updateAge` session
refresh.

We do **not** add the client plugin (`lastLoginMethodClient`) — we read the
cookie server-side in the loader, so its client helpers are unused.

The existing `videbacken-browser-session` cookie (email → server-side avatar /
name lookup) is **unchanged**; `browserSession.ts` is not touched.

### 2. Reading the method server-side

New file `src/lib/lastLoginMethodFns.ts`:

```ts
import { createServerFn } from '@tanstack/react-start'
import { getCookie } from '@tanstack/react-start/server'
import { z } from 'zod'

export const LAST_LOGIN_METHOD_COOKIE = 'better-auth.last_used_login_method'

// Narrow the plugin's raw string to the two methods this app supports; any
// other value (e.g. a future provider) → null → magic-link default.
const loginMethodSchema = z.enum(['google', 'magic-link'])
export type LoginMethod = z.infer<typeof loginMethodSchema>

export const getLastLoginMethod = createServerFn({ method: 'GET' }).handler(() => {
  const parsed = loginMethodSchema.safeParse(getCookie(LAST_LOGIN_METHOD_COOKIE))
  return parsed.success ? parsed.data : null
})
```

The `z.enum` guard means unknown / absent cookie values degrade gracefully to
`null` (→ magic-link primary), never a crash.

### 3. Loader wiring — `src/routes/login.tsx`

Only read the method when there is a remembered email (welcome-back only):

```ts
loader: async () => {
  const session = await getBrowserSession()
  if (!session?.email) return { savedLogin: null }
  const lastMethod = await getLastLoginMethod()
  return {
    savedLogin: {
      email: session.email,
      name: session.name,
      image: session.image,
      imageBlurhash: session.imageBlurhash,
      lastMethod,
    },
  }
}
```

Pass `savedLogin.lastMethod` to `WelcomeBackCard`. `LoginFormCard` is untouched.

### 4. UI — `WelcomeBackCard`

- New prop `lastMethod: LoginMethod | null`.
- `const googleIsPrimary = lastMethod === 'google'`.
- Render the primary button first — **filled (`variant="default"`)** — with a
  small muted "Senast använd" caption above it, linked via `aria-describedby`.
  Then the "ELLER" divider, then the secondary button (outline). The magic-link
  button flips to `variant="outline"` when it is secondary.
- Default / `null` / `'magic-link'` → magic-link primary + caption (current
  visual behavior preserved, now with the caption).

`GoogleSignInButton` gains two optional props so it can serve as the primary
action:

```ts
type Props = {
  callbackURL: string
  className?: string
  variant?: ComponentProps<typeof Button>['variant'] // default 'outline' (matches SubmitButton convention, ADR-0005)
  'aria-describedby'?: string
}
```

Accessibility note: the caption gives assistive tech a real cue about which
method is remembered; fill + order alone would be sighted-only.

### 5. i18n

Add one key to both catalogs (sv source of truth, en key-complete), then
`bun run i18n:compile`:

- `login_last_used` — sv: `"Senast använd"`, en: `"Last used"`.

No other user-facing strings change (reuses `login_google_button`,
`login_submit`, `common_or`, etc.).

### 6. Tests — `WelcomeBackCard.browser.test.tsx`

- Update the render helper / inline renders to pass the new `lastMethod` prop.
- **Assert behavior, not shadcn class names.** For "the remembered method is
  the primary action", assert **DOM order** (the remembered method's button
  appears first among the two action buttons — this maps to keyboard/AT
  traversal) and that the **"Senast använd" caption is associated with that
  button** (accessible-name / `aria-describedby`), which is user-facing and
  stable.
- Cases: `lastMethod='google'` (Google first + labeled), `lastMethod='magic-link'`
  and `lastMethod={null}` (magic-link first + labeled).
- Existing behavioral assertions (which sign-in call fires on click) stay green;
  rename the "secondary option" test so it isn't misleading for the
  google-primary case.

## Review outcomes (two adversarial reviews)

- **Detection soundness (confirmed at Better Auth source level):** `ctx.path`
  is populated in the relevant hooks; cookie-cache and `updateAge` refresh do
  not fire a session *create*; the Set-Cookie reaches the response including
  redirects; the magic-link new-tab flow is fine. These held regardless of
  plugin-vs-hand-roll.
- **Plugin vs hand-roll:** chose the plugin. It maintains the version-sensitive
  path→method mapping (incl. deriving the social provider from `ctx.params?.id`,
  which a hand-rolled `'google'` literal got wrong for a forked template), and
  it gates writes on a real sign-in, sidestepping admin-impersonation
  contamination.
- **Emphasis accessibility:** the filled Google button is legible (not a WCAG
  failure) in both themes, but fill+order alone is sighted-only → added the
  "Last used" caption with `aria-describedby`.
- **Pre-existing, out of scope:** `session.create.after` already overwrites the
  welcome-back *email* on admin impersonation (a pre-existing leak, unrelated to
  the method feature). Not fixed here; noted for a separate change.

## Files touched

- `src/lib/auth.ts` — register `lastLoginMethod` plugin.
- `src/lib/lastLoginMethodFns.ts` — **new**: cookie constant, enum, `getLastLoginMethod` server fn.
- `src/routes/login.tsx` — loader reads method, passes to the card.
- `src/components/login/WelcomeBackCard.tsx` — `lastMethod` prop; reorder + fill + caption.
- `src/components/login/GoogleSignInButton.tsx` — `variant` + `aria-describedby` props.
- `messages/sv.json`, `messages/en.json` — `login_last_used`; then `bun run i18n:compile`.
- `src/components/login/WelcomeBackCard.browser.test.tsx` — updated + new tests.

**Not touched:** `src/lib/browserSession.ts`, `src/lib/browserSessionFns.ts`.
No DB migration. No `auth:schema` regen (`storeInDatabase: false`). Builds on
top of the in-progress `magicLinkCallbackURL` / `googleCallbackURL` split
already in the working tree.

## Verification plan

- **Magic-link (drivable locally via Mailpit):** sign in, confirm the
  `better-auth.last_used_login_method` cookie = `magic-link`, then revisit
  `/login` and confirm magic-link is primary with the caption.
- **Google (real OAuth not available in local dev — creds are placeholders):**
  the plugin's Google detection is source-verified; exercise the read + UI
  branch by manually setting `better-auth.last_used_login_method=google` and
  loading `/login` with a remembered email → Google primary + caption.
- `bun run test:components` (WelcomeBackCard), `bun run build` (tsc), `bun run check:ci`.

## Out of scope / non-goals

- Reordering `LoginFormCard` (the fresh-email screen).
- Per-user (database) persistence (`storeInDatabase`) — the preference is
  per-browser, matching the existing cookie model.
- Fixing the pre-existing impersonation email overwrite.
- Passkeys or any third sign-in method.
