# 02 — Login Redesign (centered, branded)

**ADR:** applies [0015 — Visual Identity](../../adr/0015-visual-identity-and-design-language.md)
**Status:** ✅ implemented (2026-06-18)

A **centered, branded** login (Linear / Aave-style) — **not** a split panel (the earlier split-panel draft was
wrong; the reference products center the form on a branded page). The brand `LogoMark` sits above a **card-less**
stack of controls on a subtle `.brand-wash`. All sign-in logic is reused; only presentation changed.

---

## What changed

- **`src/routes/login.tsx`** — wrapper is now `brand-wash relative grid min-h-svh place-items-center p-4`
  with a centered `max-w-sm` column: `<LogoMark className="size-12" />` above the existing three-way state
  switch (`MagicLinkSentCard` / `WelcomeBackCard` / `LoginFormCard`). Locale switcher stays top-right.
- **Card-less components** — `LoginFormCard`, `WelcomeBackCard`, `MagicLinkSentCard` dropped their `Card`
  chrome; each renders a flat centered fragment (an `<h1 class="font-heading font-semibold text-2xl
  tracking-tight">` title + muted `<p>` description + full-width controls). Sign-in logic, hooks, the
  `useAppForm` form, the `passkeyFirst` ordering, and the avatar are unchanged.
- **No automatic passkey prompt** — removed `useSignInPasskeyAutofill` (the conditional-mediation hook), the
  hidden `webauthn-anchor` input, and the `webauthn` autocomplete token. The password-manager / browser passkey
  prompt no longer fires on load; users press the explicit **"Logga in med passkey"** button (still
  `useSignInPasskey`, modal mediation).
- **i18n** — new key `login_title`: sv "Välkommen till Oceanview" / en "Welcome to Oceanview" (the default
  state's heading — the mark carries the brand). Returning users keep "Välkommen tillbaka".

## Reused as-is
All auth behavior: `useAppForm`, `usePasskeySupport`, `authClient.signIn.{magicLink,passkey}`, `useAwaitSignIn`,
`useSignInPasskey`, `switchToOtherEmail`, loader/`beforeLoad`, `LocaleSwitcherInline`, `Logo`, `--brand` /
`.brand-wash`.

## Critical files
- `src/routes/login.tsx`
- `src/components/login/{LoginFormCard,WelcomeBackCard,MagicLinkSentCard}.tsx`
- `src/hooks/usePasskeys.ts` (removed the autofill hook)
- `messages/{sv,en}.json` (`login_title`)

## Verified
Build green. `/login` in Chrome, light + dark: centered brand-wash page, blue `LogoMark`, card-less floating
controls; default state titled "Välkommen till Oceanview", welcome-back state for a saved login; **no automatic
passkey popup**; explicit passkey button present; console clean.

## Out of scope (optional follow-up)
- `/signed-in` route + `SignedInCard` still use a `Card` — flatten later for consistency.
