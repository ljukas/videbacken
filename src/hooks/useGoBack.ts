import { useCanGoBack, useNavigate, useRouter } from '@tanstack/react-router'

/**
 * A "back" navigation for dedicated-route forms (ADR-0013): pop history when we
 * got here from another in-app screen (which restores its scroll via
 * scrollRestoration), else fall back to a fresh navigate to `fallbackTo` on a
 * cold deep-link. The returned callback doubles as a form's `onDone` handler.
 */
export function useGoBack(fallbackTo: string): () => void {
  const navigate = useNavigate()
  const router = useRouter()
  const canGoBack = useCanGoBack()
  return () => {
    if (canGoBack) router.history.back()
    else navigate({ to: fallbackTo })
  }
}
