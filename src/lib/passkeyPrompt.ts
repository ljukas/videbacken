// Remembers, per-device, that the user dismissed the "create a passkey" prompt so we
// don't re-nag them on every sign-in. Passkeys are device-bound, so localStorage (also
// device-bound) is the right scope. All access is guarded for SSR and storage being
// unavailable (private mode, blocked cookies).

const DISMISSED_UNTIL_KEY = 'oceanview-passkey-prompt-dismissed-until'
const DAY_MS = 24 * 60 * 60 * 1000

export function isPasskeyPromptSuppressed(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const raw = window.localStorage.getItem(DISMISSED_UNTIL_KEY)
    if (!raw) return false
    const until = Number.parseInt(raw, 10)
    return Number.isFinite(until) && Date.now() < until
  } catch {
    return false
  }
}

export function suppressPasskeyPrompt(days = 30): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(DISMISSED_UNTIL_KEY, String(Date.now() + days * DAY_MS))
  } catch {
    // Storage unavailable — worst case we prompt again next sign-in.
  }
}
