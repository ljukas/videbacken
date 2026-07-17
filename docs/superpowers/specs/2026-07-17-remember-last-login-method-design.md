# Remember last-used login method

**Date:** 2026-07-17
**Status:** Approved — ready for implementation plan

## Problem

The login screen shows a "Välkommen tillbaka" card (`WelcomeBackCard`) for a
returning visitor whose email we remember. That card always renders the
magic-link button as the primary (filled) action and Google as the secondary
(outline) option. This ordering is a leftover from when the template only had
magic-link / passkey.

Now that Google OAuth exists, a visitor whose last successful sign-in was via
Google is still shown magic-link as the primary button. The card should instead
promote whichever method the visitor last successfully used.

Scope is the **welcome-back card only**. The fresh login form (`LoginFormCard`,
shown for a new or "log in as someone else" email) keeps its current order.

## Decisions (from brainstorming)

- **Detection: on successful sign-in only** — record the method server-side at
  the moment a session is actually created, staying consistent with how the
  email is remembered today. Not on click/attempt.
- **Scope: welcome-back card only.**
- **Primary style: reorder + emphasize** — the remembered method moves to the
  top *and* takes the filled (`variant="default"`) style; the other method
  becomes the outline secondary below the "ELLER" divider.
- **Storage: extend the existing visitor cookie**, rather than adopting Better
  Auth's official `lastLoginMethod` plugin. The plugin would introduce a
  second, client-readable cookie that overlaps our existing httpOnly
  `videbacken-browser-session` "visitor memo". Email and last-method are one
  conceptual unit ("what we remember about this visitor"), so they live in one
  cookie, written at one place.

## Design

### 1. Storage — extend `videbacken-browser-session`

`src/lib/browserSession.ts` already stores `{ email }` in an httpOnly cookie,
read server-side by the login loader. Add an optional field:

```ts
export const browserSessionSchema = z.object({
  email: z.email(),
  lastMethod: z.enum(['google', 'magic-link']).optional(),
})
```

`lastMethod` is optional, so cookies written before this change still parse
(→ treated as "unknown", which falls back to magic-link primary).

`rememberUser` gains an optional `method` parameter:

```ts
export async function rememberUser(
  _userId: string,
  email: string,
  method?: 'google' | 'magic-link',
): Promise<void> {
  const current = readBrowserSession()
  const next = { email, lastMethod: method ?? current?.lastMethod }
  if (current?.email !== next.email || current?.lastMethod !== next.lastMethod) {
    writeBrowserSession(next)
  }
}
```

- When `method` is omitted (the full-page-load refresh call), the existing
  `lastMethod` is **preserved**.
- The cookie is rewritten when either the email *or* the method changed.

Both existing callers stay correct:
- `auth.ts` `session.create.after` → passes the detected method.
- `browserSessionFns.ts` `rememberBrowserUser` (invoked on authenticated
  full-page loads) → passes no method → method preserved.

`getBrowserSession` already spreads `...session` into its result, so
`lastMethod` flows through to the loader with no change to that server fn.

### 2. Detection — in `auth.ts` `session.create.after`

Better Auth passes the endpoint context as the second hook argument; `ctx.path`
is the route pattern. Confirmed values (from Better Auth source):

- `/callback/:id` → social provider callback → `'google'` (the only social
  provider configured).
- `/magic-link/verify` → `'magic-link'`.
- anything else → `null` → leave the remembered method untouched.

```ts
function resolveLoginMethod(ctx): 'google' | 'magic-link' | null {
  const path = ctx?.path
  if (!path) return null
  if (path === '/callback/:id' || path.startsWith('/callback/')) return 'google'
  if (path.startsWith('/magic-link/verify')) return 'magic-link'
  return null
}
```

The hook becomes:

```ts
session: {
  create: {
    after: async (session, ctx) => {
      logger.info('auth session created', { ... })
      try {
        const row = await userService.findRowById(session.userId)
        if (row) await rememberUser(session.userId, row.email, resolveLoginMethod(ctx))
      } catch (error) {
        logger.warn('welcome-back cookie write failed', { error })
      }
    },
  },
},
```

**Verification note:** before trusting `ctx.path`, confirm empirically (a
temporary log or a driven sign-in) that it is populated inside
`session.create.after` for both the Google and magic-link flows.

### 3. UI — `WelcomeBackCard`

- New prop `lastMethod: 'google' | 'magic-link' | null`.
- `const googleIsPrimary = lastMethod === 'google'`.
- Render the primary button first (filled, `variant="default"`), the divider,
  then the secondary (outline). The magic-link button flips to `variant="outline"`
  when secondary.

`GoogleSignInButton` gets a `variant` prop (default `'outline'`) so it can be
rendered filled when it is the primary action:

```ts
type Props = {
  callbackURL: string
  className?: string
  variant?: 'default' | 'outline'  // matches Button's variant union
}
```

`src/routes/login.tsx` loader includes `lastMethod` in `savedLogin` and passes
it to `WelcomeBackCard`. `LoginFormCard` is untouched.

### 4. Tests — `WelcomeBackCard.browser.test.tsx`

- Update the render helper to pass the new `lastMethod` prop.
- `lastMethod='google'` → Google button appears first among the actions and is
  filled; magic-link appears second and is outline.
- `lastMethod='magic-link'` and `lastMethod={null}` → magic-link first/filled
  (current behavior preserved).
- Existing behavioral assertions (which sign-in call fires on click) stay green.

## Files touched

- `src/lib/browserSession.ts` — schema + `rememberUser` signature/merge.
- `src/lib/auth.ts` — `resolveLoginMethod` + updated `session.create.after`.
- `src/routes/login.tsx` — loader passes `lastMethod` to the card.
- `src/components/login/WelcomeBackCard.tsx` — conditional order + variants.
- `src/components/login/GoogleSignInButton.tsx` — `variant` prop.
- `src/components/login/WelcomeBackCard.browser.test.tsx` — new/updated tests.

No DB migration. No new dependency. Builds on top of the in-progress
`magicLinkCallbackURL` / `googleCallbackURL` split already in the working tree.

## Out of scope / non-goals

- Reordering `LoginFormCard` (the fresh-email screen).
- Per-user (database) persistence of the last method — the preference is
  per-browser, matching the existing cookie model.
- Passkeys or any third sign-in method.
