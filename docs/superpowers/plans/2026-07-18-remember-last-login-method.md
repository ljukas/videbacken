# Remember last-used login method — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the login "welcome back" card, promote whichever method (Google OAuth or email magic-link) the visitor last successfully used to the primary (filled, first) action, with a "last used" caption.

**Architecture:** Detection/storage is delegated to Better Auth's official `lastLoginMethod` plugin, which writes a plain, client-readable cookie `better-auth.last_used_login_method` on successful sign-in. A server fn reads that cookie during the `/login` loader (only when a remembered email exists) and passes the method to `WelcomeBackCard`, which reorders + emphasizes the primary button and shows an `aria-describedby`-linked caption. The fresh-email `LoginFormCard` is untouched.

**Tech Stack:** TanStack Start (RC) + Vite, Better Auth (v1.6.23) `lastLoginMethod` plugin, Zod, Paraglide i18n, shadcn/Radix `Button`, Vitest browser project (Chromium/Playwright).

**Spec:** `docs/superpowers/specs/2026-07-17-remember-last-login-method-design.md`

## Global Constraints

- Package manager is **bun**: all commands are `bun run <script>` / `bunx <cli>`.
- User-facing text is **Paraglide-localized**: add keys to `messages/sv.json` (source of truth) **and** `messages/en.json` (key-complete). "Videbacken" stays untranslated. Route URL paths stay English.
- **Never hand-edit `src/lib/db/schema/betterAuth.ts`**, and **do NOT run `bun run auth:schema`** for this work — the plugin uses `storeInDatabase: false`, so it adds no schema; a regen is an unnecessary no-op.
- **All logging through `~/lib/logger/`** — never `console.*`. (No new logging is added here.)
- Component tests run in the **browser** Vitest project (`bun run test:components`); files are `*.browser.test.tsx` and render via `renderWithProviders` from `~test/browser/render`.
- **Conventional Commits**, subject ≤72 chars, imperative. Commit after each task.
- Biome is the formatter/linter; run `bun run check` before committing to auto-fix format/imports; `bun run check:ci` must stay green.
- `src/paraglide/` is generated and untracked — run `bun run i18n:compile` after editing messages, but do **not** git-add generated paraglide files.
- **Scope discipline:** each task lists the exact files it may create/modify. Do not edit, refactor, or "clean up" any file not listed for that task.

---

## Preparation (orchestrator, before dispatching task subagents)

The working tree contains an in-progress, self-contained refactor (splitting the single `callbackURL` prop into `magicLinkCallbackURL` / `googleCallbackURL`) across five files:
`src/components/login/LoginFormCard.tsx`, `src/components/login/LoginFormCard.browser.test.tsx`, `src/components/login/WelcomeBackCard.tsx`, `src/components/login/WelcomeBackCard.browser.test.tsx`, `src/routes/login.tsx`.

Commit it as a clean baseline so every feature task below produces a pure delta.

- [ ] **Step 1: Confirm the refactor baseline is green**

Run: `bun run test:components -- src/components/login`
Expected: PASS (LoginFormCard + WelcomeBackCard browser tests).

- [ ] **Step 2: Commit the refactor baseline**

```bash
git add src/components/login/LoginFormCard.tsx \
        src/components/login/LoginFormCard.browser.test.tsx \
        src/components/login/WelcomeBackCard.tsx \
        src/components/login/WelcomeBackCard.browser.test.tsx \
        src/routes/login.tsx
git commit -m "refactor(login): split callbackURL into magic-link vs google"
```

Expected: clean working tree (`git status --short` empty).

---

## Task 1: Add the "last used" i18n key

**Files:**
- Modify: `messages/sv.json`
- Modify: `messages/en.json`

**Interfaces:**
- Produces: message function `m.login_last_used()` → `"Senast använd"` (sv) / `"Last used"` (en), consumed by Task 4.

- [ ] **Step 1: Add the key to `messages/sv.json`**

Insert this line immediately after the `"login_google_button": ...,` line (keys are alphabetical by suffix, so `last_used` sits between `google_button` and `send_error`):

```json
  "login_last_used": "Senast använd",
```

- [ ] **Step 2: Add the key to `messages/en.json`**

Insert immediately after the `"login_google_button": ...,` line:

```json
  "login_last_used": "Last used",
```

- [ ] **Step 3: Compile messages**

Run: `bun run i18n:compile`
Expected: exits 0, no errors.

- [ ] **Step 4: Verify the message function exists**

Run: `grep -rl "login_last_used" src/paraglide/`
Expected: at least one generated file matches (the function was generated).

- [ ] **Step 5: Commit** (stage only the source catalogs — generated paraglide files are untracked)

```bash
git add messages/sv.json messages/en.json
git commit -m "feat(login): add last-used caption i18n key"
```

---

## Task 2: Server fn to read the last-login-method cookie

**Files:**
- Create: `src/lib/lastLoginMethodFns.ts`

**Interfaces:**
- Produces:
  - `export const LAST_LOGIN_METHOD_COOKIE = 'better-auth.last_used_login_method'`
  - `export type LoginMethod = 'google' | 'magic-link'` (via `z.infer`)
  - `export const getLastLoginMethod` — a TanStack Start GET server fn returning `Promise<LoginMethod | null>`.
- Consumed by: Task 4 (`LoginMethod` type) and Task 6 (`getLastLoginMethod`).

**Note on testing:** This is a cookie-reading server fn. Following the existing convention (`src/lib/browserSessionFns.ts` has no unit test — server fns / cookie readers aren't unit-tested in this repo), it is verified by `tsc` + the end-to-end verification in Task 7, not a bespoke unit test. The `z.enum` guard makes unknown/absent values degrade to `null`.

- [ ] **Step 1: Create the file**

```ts
import { createServerFn } from '@tanstack/react-start'
import { getCookie } from '@tanstack/react-start/server'
import { z } from 'zod'

// Cookie written by Better Auth's lastLoginMethod plugin (registered in
// src/lib/auth.ts). Plain, unsigned string value; client-readable.
export const LAST_LOGIN_METHOD_COOKIE = 'better-auth.last_used_login_method'

// Narrow the plugin's raw string to the two methods this app supports; any
// other value (absent cookie, a future provider) → null → magic-link default.
const loginMethodSchema = z.enum(['google', 'magic-link'])
export type LoginMethod = z.infer<typeof loginMethodSchema>

export const getLastLoginMethod = createServerFn({ method: 'GET' }).handler(() => {
  const parsed = loginMethodSchema.safeParse(getCookie(LAST_LOGIN_METHOD_COOKIE))
  return parsed.success ? parsed.data : null
})
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no errors related to `src/lib/lastLoginMethodFns.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/lastLoginMethodFns.ts
git commit -m "feat(login): add getLastLoginMethod cookie reader"
```

---

## Task 3: Let `GoogleSignInButton` render as the primary action

**Files:**
- Modify: `src/components/login/GoogleSignInButton.tsx`
- Create: `src/components/login/GoogleSignInButton.browser.test.tsx`

**Interfaces:**
- Consumes: `Button` (`data-variant` attribute reflects the chosen variant).
- Produces: `GoogleSignInButton` now accepts `variant?: ComponentProps<typeof Button>['variant']` (default `'outline'`) and `'aria-describedby'?: string`, both forwarded to the underlying `Button`. Consumed by Task 4.

- [ ] **Step 1: Write the failing test**

Create `src/components/login/GoogleSignInButton.browser.test.tsx`:

```tsx
import { expect, test, vi } from 'vitest'
import { renderWithProviders } from '~test/browser/render'
import { GoogleSignInButton } from './GoogleSignInButton'

// The component imports authClient at module load; mock it so construction is
// inert (we don't click in these tests).
vi.mock('~/lib/authClient', () => ({
  authClient: { signIn: { social: vi.fn() } },
}))

test('defaults to the outline (secondary) variant', async () => {
  const { screen } = await renderWithProviders(<GoogleSignInButton callbackURL="/" />)
  const button = screen.container.querySelector('button')
  expect(button?.getAttribute('data-variant')).toBe('outline')
})

test('renders the requested variant and forwards aria-describedby', async () => {
  const { screen } = await renderWithProviders(
    <GoogleSignInButton callbackURL="/" variant="default" aria-describedby="hint-1" />,
  )
  const button = screen.container.querySelector('button')
  expect(button?.getAttribute('data-variant')).toBe('default')
  expect(button?.getAttribute('aria-describedby')).toBe('hint-1')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:components -- src/components/login/GoogleSignInButton.browser.test.tsx`
Expected: the second test FAILS (`data-variant` is `outline`, not `default`; `aria-describedby` is null) because the props aren't wired yet.

- [ ] **Step 3: Implement the props**

Replace the entire contents of `src/components/login/GoogleSignInButton.tsx` with:

```tsx
import type { ComponentProps } from 'react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '~/components/ui/button'
import { Spinner } from '~/components/ui/spinner'
import { authClient } from '~/lib/authClient'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { GoogleIcon } from './GoogleIcon'

type Props = {
  callbackURL: string
  className?: string
  // Defaults to the outline (secondary) look; the welcome-back card passes
  // 'default' to render Google as the primary, filled action.
  variant?: ComponentProps<typeof Button>['variant']
  'aria-describedby'?: string
}

// Shared by LoginFormCard (primary sign-in surface) and WelcomeBackCard
// (either the primary or secondary option) so both stay wired to the exact
// same `signIn.social` call and error handling.
export function GoogleSignInButton({
  callbackURL,
  className,
  variant = 'outline',
  'aria-describedby': ariaDescribedBy,
}: Props) {
  const [isPending, setIsPending] = useState(false)

  async function signInWithGoogle() {
    setIsPending(true)
    const { error } = await authClient.signIn.social({ provider: 'google', callbackURL })
    if (error) {
      // On success the browser navigates away to Google, so isPending never
      // needs resetting in that branch — only the error path returns here.
      setIsPending(false)
      toast.error(error.message ?? m.login_send_error())
    }
  }

  return (
    <Button
      type="button"
      variant={variant}
      size="xl"
      className={cn('w-full font-normal', className)}
      disabled={isPending}
      aria-describedby={ariaDescribedBy}
      onClick={() => {
        void signInWithGoogle()
      }}
    >
      {isPending ? (
        <Spinner data-icon="inline-start" />
      ) : (
        <GoogleIcon data-icon="inline-start" className="size-4" />
      )}
      {m.login_google_button()}
    </Button>
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test:components -- src/components/login/GoogleSignInButton.browser.test.tsx`
Expected: both tests PASS.

- [ ] **Step 5: Lint/format**

Run: `bun run check`
Expected: no remaining errors (imports organized, formatted).

- [ ] **Step 6: Commit**

```bash
git add src/components/login/GoogleSignInButton.tsx \
        src/components/login/GoogleSignInButton.browser.test.tsx
git commit -m "feat(login): let GoogleSignInButton take a variant"
```

---

## Task 4: Reorder + emphasize the welcome-back card

**Files:**
- Modify: `src/components/login/WelcomeBackCard.tsx`
- Modify: `src/components/login/WelcomeBackCard.browser.test.tsx`

**Interfaces:**
- Consumes: `type LoginMethod` from `~/lib/lastLoginMethodFns` (Task 2); `GoogleSignInButton`'s `variant` + `aria-describedby` props (Task 3); `m.login_last_used()` (Task 1); `Button`'s `data-variant` attribute.
- Produces: `WelcomeBackCard` now requires a `lastMethod: LoginMethod | null` prop. Consumed by Task 6.

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `src/components/login/WelcomeBackCard.browser.test.tsx` with:

```tsx
import { expect, test, vi } from 'vitest'
import type { LoginMethod } from '~/lib/lastLoginMethodFns'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { WelcomeBackCard } from './WelcomeBackCard'

// `vi.mock` factories are hoisted above the file, so the mocks they reference
// must live in `vi.hoisted` (also hoisted) rather than ordinary top-level
// consts — codebase idiom, see heicTranscode.test.ts.
const { signInSocial, signInMagicLink } = vi.hoisted(() => ({
  signInSocial: vi.fn(),
  signInMagicLink: vi.fn(),
}))

vi.mock('~/lib/authClient', () => ({
  authClient: {
    signIn: {
      social: signInSocial,
      magicLink: signInMagicLink,
    },
  },
}))

// Magic link lands on /signed-in in a new tab; Google stays in this tab and
// goes straight to the destination. The two callbacks are deliberately distinct.
const MAGIC_LINK_CALLBACK_URL = '/signed-in?redirect=%2F'
const GOOGLE_CALLBACK_URL = '/'

function renderCard(lastMethod: LoginMethod | null = null, onSent: (email: string) => void = () => {}) {
  return renderWithProviders(
    <WelcomeBackCard
      email="alice@example.se"
      name="Alice Svensson"
      image={null}
      imageBlurhash={null}
      lastMethod={lastMethod}
      magicLinkCallbackURL={MAGIC_LINK_CALLBACK_URL}
      googleCallbackURL={GOOGLE_CALLBACK_URL}
      onSent={onSent}
      onSwitchUser={() => {}}
    />,
  )
}

// DOM index of each action button (-1 if absent). Lower index = earlier in the
// document = the primary position / earlier keyboard traversal.
function buttonOrder(container: Element) {
  const buttons = Array.from(container.querySelectorAll('button'))
  return {
    google: buttons.findIndex((b) => b.textContent?.includes(m.login_google_button())),
    magicLink: buttons.findIndex((b) => b.textContent?.includes(m.login_submit())),
  }
}

function findButton(container: Element, label: string) {
  return Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(label),
  )
}

test('offers the Google button as a secondary option alongside the one-click magic-link resend (no passkey)', async () => {
  const { screen } = await renderCard()

  await expect.element(screen.getByRole('button', { name: m.login_submit() })).toBeVisible()
  await expect.element(screen.getByRole('button', { name: m.login_google_button() })).toBeVisible()
  await expect.element(screen.getByRole('button', { name: m.login_switch_user() })).toBeVisible()

  expect(screen.container.textContent?.toLowerCase()).not.toContain('passkey')
})

test('defaults to magic-link as the primary (filled, first) action with the last-used caption', async () => {
  const { screen } = await renderCard(null)
  const order = buttonOrder(screen.container)
  expect(order.magicLink).toBeLessThan(order.google)

  const magic = findButton(screen.container, m.login_submit())
  const google = findButton(screen.container, m.login_google_button())
  expect(magic?.getAttribute('data-variant')).toBe('default')
  expect(google?.getAttribute('data-variant')).toBe('outline')

  const describedBy = magic?.getAttribute('aria-describedby')
  expect(describedBy).toBeTruthy()
  expect(screen.container.querySelector(`#${describedBy}`)?.textContent).toBe(m.login_last_used())
})

test('promotes Google to the primary (filled, first) action when it was last used', async () => {
  const { screen } = await renderCard('google')
  const order = buttonOrder(screen.container)
  expect(order.google).toBeLessThan(order.magicLink)

  const google = findButton(screen.container, m.login_google_button())
  const magic = findButton(screen.container, m.login_submit())
  expect(google?.getAttribute('data-variant')).toBe('default')
  expect(magic?.getAttribute('data-variant')).toBe('outline')

  const describedBy = google?.getAttribute('aria-describedby')
  expect(describedBy).toBeTruthy()
  expect(screen.container.querySelector(`#${describedBy}`)?.textContent).toBe(m.login_last_used())
})

test('clicking the Google button calls signIn.social with the provider and the same-tab destination', async () => {
  signInSocial.mockResolvedValue({ error: null })
  const { screen } = await renderCard()

  await screen.getByRole('button', { name: m.login_google_button() }).click()

  // Google must NOT route through /signed-in — it uses the plain destination.
  expect(signInSocial).toHaveBeenCalledWith({
    provider: 'google',
    callbackURL: GOOGLE_CALLBACK_URL,
  })
})

test('clicking the primary button still resends a magic link to the saved email', async () => {
  signInMagicLink.mockResolvedValue({ error: null })
  const onSent = vi.fn()
  const { screen } = await renderCard(null, onSent)

  await screen.getByRole('button', { name: m.login_submit() }).click()

  await vi.waitFor(() => {
    expect(signInMagicLink).toHaveBeenCalledWith({
      email: 'alice@example.se',
      callbackURL: MAGIC_LINK_CALLBACK_URL,
    })
    expect(onSent).toHaveBeenCalledWith('alice@example.se')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test:components -- src/components/login/WelcomeBackCard.browser.test.tsx`
Expected: FAIL — `WelcomeBackCard` doesn't accept `lastMethod`, there's no `last-used` caption, and `data-variant`/order assertions don't hold yet.

- [ ] **Step 3: Implement the card**

Replace the entire contents of `src/components/login/WelcomeBackCard.tsx` with:

```tsx
import { useState } from 'react'
import { toast } from 'sonner'
import { GoogleSignInButton } from '~/components/login/GoogleSignInButton'
import { Avatar, AvatarFallback, AvatarImage } from '~/components/ui/avatar'
import { Button } from '~/components/ui/button'
import { Separator } from '~/components/ui/separator'
import { Spinner } from '~/components/ui/spinner'
import { authClient } from '~/lib/authClient'
import type { LoginMethod } from '~/lib/lastLoginMethodFns'
import { initials } from '~/lib/utils'
import { m } from '~/paraglide/messages'

// Links the "last used" caption to whichever button it describes (aria-describedby).
const LAST_USED_HINT_ID = 'welcome-back-last-used'

type Props = {
  email: string
  // Resolved server-side by the login loader from the cookie's email — kept
  // out of the cookie itself so it never goes stale.
  name: string | null
  image: string | null
  imageBlurhash: string | null
  // Which method this browser last successfully signed in with; promotes that
  // button to the primary (filled, first) action. null → magic-link default.
  lastMethod: LoginMethod | null
  onSent: (email: string) => void
  onSwitchUser: () => void
  // Magic link opens in a new tab and lands on /signed-in; Google stays in this
  // tab and goes straight to the destination. See src/routes/login.tsx.
  magicLinkCallbackURL: string
  googleCallbackURL: string
}

export function WelcomeBackCard({
  email,
  name,
  image,
  imageBlurhash,
  lastMethod,
  onSent,
  onSwitchUser,
  magicLinkCallbackURL,
  googleCallbackURL,
}: Props) {
  const [isSending, setIsSending] = useState(false)
  const googleIsPrimary = lastMethod === 'google'

  async function sendMagicLink() {
    setIsSending(true)
    const { error } = await authClient.signIn.magicLink({
      email,
      callbackURL: magicLinkCallbackURL,
    })
    setIsSending(false)
    if (error) {
      toast.error(error.message ?? m.login_send_error())
      return
    }
    onSent(email)
  }

  const magicLinkButton = (
    <Button
      type="button"
      variant={googleIsPrimary ? 'outline' : 'default'}
      size="xl"
      className="w-full font-normal"
      disabled={isSending}
      aria-describedby={googleIsPrimary ? undefined : LAST_USED_HINT_ID}
      onClick={() => {
        void sendMagicLink()
      }}
    >
      {isSending && <Spinner data-icon="inline-start" />}
      {isSending ? m.login_submit_pending() : m.login_submit()}
    </Button>
  )

  const googleButton = (
    <GoogleSignInButton
      callbackURL={googleCallbackURL}
      variant={googleIsPrimary ? 'default' : 'outline'}
      aria-describedby={googleIsPrimary ? LAST_USED_HINT_ID : undefined}
    />
  )

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <h1 className="font-heading font-semibold text-2xl tracking-tight">
        {m.login_welcome_back_title()}
      </h1>

      <div className="flex max-w-full items-center gap-2.5 rounded-full border bg-background/60 py-1 pr-4 pl-1">
        <Avatar className="size-8 shrink-0">
          {image ? (
            <AvatarImage src={image} alt={email} width={32} height={32} blurhash={imageBlurhash} />
          ) : null}
          <AvatarFallback className="font-semibold text-xs">
            {name?.trim() ? initials(name) : (email[0]?.toUpperCase() ?? '?')}
          </AvatarFallback>
        </Avatar>
        <span className="min-w-0 truncate font-medium text-sm">{email}</span>
      </div>

      <div className="flex w-full flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <span id={LAST_USED_HINT_ID} className="text-center text-muted-foreground text-xs">
            {m.login_last_used()}
          </span>
          {googleIsPrimary ? googleButton : magicLinkButton}
        </div>

        <div className="flex items-center gap-3">
          <Separator className="flex-1" />
          <span className="text-muted-foreground text-xs uppercase">{m.common_or()}</span>
          <Separator className="flex-1" />
        </div>

        {googleIsPrimary ? magicLinkButton : googleButton}

        <Button
          type="button"
          variant="link"
          className="h-auto p-0 text-muted-foreground text-sm"
          onClick={onSwitchUser}
        >
          {m.login_switch_user()}
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test:components -- src/components/login/WelcomeBackCard.browser.test.tsx`
Expected: all tests PASS.

- [ ] **Step 5: Lint/format**

Run: `bun run check`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/login/WelcomeBackCard.tsx \
        src/components/login/WelcomeBackCard.browser.test.tsx
git commit -m "feat(login): promote last-used method on welcome-back card"
```

---

## Task 5: Register the `lastLoginMethod` plugin

**Files:**
- Modify: `src/lib/auth.ts`

**Interfaces:**
- Produces: on successful sign-in, Better Auth writes the `better-auth.last_used_login_method` cookie read by Task 2. No exported symbols change.

**Do NOT** run `bun run auth:schema` (storeInDatabase is false → no schema change).

- [ ] **Step 1: Add the import**

In `src/lib/auth.ts`, change the plugins import (currently `import { admin, magicLink } from 'better-auth/plugins'`) to:

```ts
import { admin, lastLoginMethod, magicLink } from 'better-auth/plugins'
```

- [ ] **Step 2: Register the plugin**

In the `plugins: [...]` array, insert `lastLoginMethod(...)` immediately before `tanstackStartCookies()`. The array becomes:

```ts
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        const normalized = normalizeEmail(email)
        // Allowlist gate: never send a link to an email that isn't approved.
        // This is the magic-link half of the two-entry-point gate (the other is
        // databaseHooks.user.create.before, which covers Google + first-sign-in
        // account creation). Approved-but-account-less emails still get a link —
        // Better Auth creates the user on first click, re-checked by that hook.
        if (!(await isApproved(normalized))) {
          logger.info('magic-link denied (not approved)', { email: normalized })
          throw new APIError('BAD_REQUEST', {
            message: m.login_unknown_email_error(),
          })
        }
        // sendMagicLink runs inside the request's Paraglide scope (the
        // /api/auth/* route goes through src/server.ts), so getLocale()
        // reflects the requester's cookie.
        await emailEffect.sendMagicLink({ to: email, url, locale: getLocale() })
        logger.info('magic-link sent', { email: normalized })
      },
    }),
    admin(),
    // Records the last successful sign-in method in a plain, client-readable
    // cookie (better-auth.last_used_login_method). The /login loader reads it
    // (see src/lib/lastLoginMethodFns.ts) to promote that method on the
    // welcome-back card. storeInDatabase stays false → no schema change.
    // maxAge matches the 1-year welcome-back email cookie so the two agree.
    lastLoginMethod({ maxAge: 60 * 60 * 24 * 365 }),
    tanstackStartCookies(),
  ],
```

(Leave the surrounding `magicLink`/`admin` config exactly as-is — only the import line and the inserted `lastLoginMethod(...)` line change.)

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Lint/format**

Run: `bun run check`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth.ts
git commit -m "feat(auth): track last login method via Better Auth plugin"
```

---

## Task 6: Read the method in the login loader and pass it to the card

**Files:**
- Modify: `src/routes/login.tsx`

**Interfaces:**
- Consumes: `getLastLoginMethod` from `~/lib/lastLoginMethodFns` (Task 2); `WelcomeBackCard`'s `lastMethod` prop (Task 4).

- [ ] **Step 1: Add the import**

In `src/routes/login.tsx`, add next to the existing browser-session import:

```ts
import { getLastLoginMethod } from '~/lib/lastLoginMethodFns'
```

- [ ] **Step 2: Read the method in the loader (only when a saved email exists)**

Replace the current `loader`:

```ts
  loader: async () => {
    const session = await getBrowserSession()
    return {
      savedLogin: session?.email
        ? {
            email: session.email,
            name: session.name,
            image: session.image,
            imageBlurhash: session.imageBlurhash,
          }
        : null,
    }
  },
```

with:

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
  },
```

- [ ] **Step 3: Pass `lastMethod` to `WelcomeBackCard`**

In the JSX, add the `lastMethod` prop to the `<WelcomeBackCard ... />` element (alongside the existing props):

```tsx
          <WelcomeBackCard
            email={savedLogin.email}
            name={savedLogin.name}
            image={savedLogin.image}
            imageBlurhash={savedLogin.imageBlurhash}
            lastMethod={savedLogin.lastMethod}
            magicLinkCallbackURL={magicLinkCallbackURL}
            googleCallbackURL={destination}
            onSent={setSentTo}
            onSwitchUser={() => {
              void switchToOtherEmail()
            }}
          />
```

- [ ] **Step 4: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no errors (the `savedLogin.lastMethod` type flows into the card's required `lastMethod` prop).

- [ ] **Step 5: Lint/format**

Run: `bun run check`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/routes/login.tsx
git commit -m "feat(login): pass last-used method into welcome-back card"
```

---

## Task 7: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Full component test suite**

Run: `bun run test:components`
Expected: all PASS (GoogleSignInButton, WelcomeBackCard, LoginFormCard included).

- [ ] **Step 2: Build (typecheck included)**

Run: `bun run build`
Expected: succeeds (`vite build && tsc --noEmit`).

- [ ] **Step 3: Lint gate**

Run: `bun run check:ci`
Expected: no diffs / no errors.

- [ ] **Step 4: Runtime — magic-link path (drivable locally)**

Start the dev stack (`bun run dev:up` then `bun run dev`), sign in with an `INITIAL_ADMIN_EMAILS` address via the magic link (Mailpit at :14602). Then, using the /verify or claude-in-chrome tooling:
- Confirm a cookie `better-auth.last_used_login_method=magic-link` is set after sign-in.
- Sign out, revisit `/login`: the "Välkommen tillbaka" card shows the magic-link button as primary (filled, first) with the "Senast använd" caption.

- [ ] **Step 5: Runtime — Google branch (read+UI only; real OAuth unavailable in local dev)**

With a remembered email present, manually set the cookie `better-auth.last_used_login_method=google` (e.g. via devtools/`document.cookie`) and reload `/login`. Confirm the Google button becomes primary (filled, first) with the "Senast använd" caption, and magic-link drops to the outline secondary below "ELLER".

- [ ] **Step 6: Report**

Summarize results (tests, build, lint, both runtime checks) with evidence. Do not claim success without the command output.

---

## Self-review (author)

- **Spec coverage:** plugin registration (Task 5) ✓; cookie reader (Task 2) ✓; loader wiring (Task 6) ✓; reorder+fill+caption UI (Task 4) ✓; GoogleSignInButton variant (Task 3) ✓; i18n key (Task 1) ✓; behavioral tests via DOM order + `data-variant` + caption association (Tasks 3–4) ✓; verification incl. magic-link runtime + manual google-cookie (Task 7) ✓. Out-of-scope items (LoginFormCard, storeInDatabase, impersonation email leak) remain untouched ✓.
- **Placeholders:** none — every code/step is concrete.
- **Type consistency:** `LoginMethod` defined in Task 2 and consumed by Tasks 4 & 6; `getLastLoginMethod` returns `LoginMethod | null`, matching `savedLogin.lastMethod` → the card's `lastMethod` prop; `variant` typed as `ComponentProps<typeof Button>['variant']` in Task 3 and used in Task 4; `LAST_USED_HINT_ID` referenced consistently within Task 4.
