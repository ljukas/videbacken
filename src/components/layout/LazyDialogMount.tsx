import { useHydrated } from '@tanstack/react-router'
import { type ReactNode, Suspense, useState } from 'react'

/**
 * Mounts a lazily loaded (`React.lazy`) dialog the first time it opens, then
 * keeps it mounted (ADR-0025 §6). Until then nothing renders, so a viewer who
 * never opens it never fetches its chunk, or the form code the chunk pulls in.
 * Once loaded it stays: Radix plays its exit animation, and reopening is instant.
 * A URL deep link (ADR-0013) opens right after hydration, not in the first render:
 * an `open` that reads client-only data (a deferred query) must not differ between
 * the server and the hydrating client, and Radix's Portal renders nothing on the
 * server anyway.
 */
export function LazyDialogMount({ open, children }: { open: boolean; children: ReactNode }) {
  const [opened, setOpened] = useState(false)
  const hydrated = useHydrated()
  // Adjusting state during render on a prop change (React's documented pattern):
  // no effect, so the dialog mounts in the same render that opens it.
  if (open && hydrated && !opened) setOpened(true)
  return opened ? <Suspense fallback={null}>{children}</Suspense> : null
}
