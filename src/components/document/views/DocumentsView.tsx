import { useEffect, useState } from 'react'
import type { CurrentUser } from '~/components/document/shared/documentHelpers'
import { DocumentsDesktop } from '~/components/document/views/DocumentsDesktop'
import { DocumentsMobile } from '~/components/document/views/DocumentsMobile'
import { PageContainer } from '~/components/layout/PageContainer'
import { Skeleton } from '~/components/ui/skeleton'
import { useIsCoarsePointer } from '~/hooks/useMobile'

type Props = {
  /** Resolved folder id from the URL, or null for the virtual root. */
  activeFolderId: string | null
  currentUser: CurrentUser
  /** Document id to scroll to + flash (command-palette `?focus`), or null. */
  focusedDocId: string | null
}

/**
 * The documents library, shared by the root index route and the `/documents/$`
 * splat route. Picks the interaction model by pointer type: the touch tree
 * (`DocumentsMobile`, Drive-style tap + long-press) on coarse pointers, the
 * mouse tree (`DocumentsDesktop`, OS-style table + drag-and-drop) otherwise.
 *
 * Pointer type only resolves after mount, so we render a skeleton until then —
 * the same output on the server and the first client render, which avoids both a
 * wrong-tree flash and a hydration mismatch. The data is primed by the route
 * loaders, so the swap to the real tree is immediate.
 */
export function DocumentsView({ activeFolderId, currentUser, focusedDocId }: Props) {
  const coarse = useIsCoarsePointer()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  if (!mounted) return <DocumentsSkeleton />

  return coarse ? (
    <DocumentsMobile
      activeFolderId={activeFolderId}
      currentUser={currentUser}
      focusedDocId={focusedDocId}
    />
  ) : (
    <DocumentsDesktop
      activeFolderId={activeFolderId}
      currentUser={currentUser}
      focusedDocId={focusedDocId}
    />
  )
}

function DocumentsSkeleton() {
  return (
    <PageContainer width="full" className="gap-4">
      <Skeleton className="h-10 w-48" />
      <Skeleton className="h-5 w-72" />
      <div className="flex flex-col gap-2 pt-4">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-14 w-full rounded-lg" />
        ))}
      </div>
    </PageContainer>
  )
}
