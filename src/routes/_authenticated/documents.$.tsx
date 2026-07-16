import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Navigate } from '@tanstack/react-router'
import { z } from 'zod'
import { resolveFolderBySplat } from '~/components/document/shared/documentHelpers'
import { DocumentsView } from '~/components/document/views/DocumentsView'
import { orpc } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

// `focus` = a document id the command palette navigated to; it scrolls the row
// into view and flashes a brand ring. Persisted in the URL so a refresh re-runs it.
const documentsSearchSchema = z.object({ focus: z.string().optional() })

export const Route = createFileRoute('/_authenticated/documents/$')({
  head: () => ({
    meta: seo({
      title: `${m.meta_documents_title()} | Oceanview`,
      description: m.meta_documents_description(),
    }),
  }),
  validateSearch: documentsSearchSchema,
  // Resolve the folder from the splat here so `defaultPreload: 'intent'` (router)
  // prefetches *this* folder's documents on hover — not the whole library. The
  // component re-resolves for render/redirect + realtime; an unresolvable splat
  // prefetches root (harmless — the component redirects to /documents).
  loader: async ({ context: { queryClient }, params }) => {
    const folders = await queryClient.ensureQueryData(orpc.folder.tree.queryOptions())
    const folder = resolveFolderBySplat(folders, params._splat)
    await queryClient.ensureQueryData(
      orpc.document.listDocuments.queryOptions({ input: { folderId: folder?.id ?? null } }),
    )
  },
  component: DocumentsFolder,
})

function DocumentsFolder() {
  const { user } = Route.useRouteContext()
  // `_splat` is already URI-decoded by the router (e.g. "Bilder/Sommar 2024").
  const { _splat } = Route.useParams()
  const focus = Route.useSearch({ select: (s) => s.focus })
  const { data: folders } = useSuspenseQuery(orpc.folder.tree.queryOptions())

  // Resolve in the component (not the loader) so a realtime tree refetch after a
  // rename/move re-resolves automatically. A stale path no longer matches → root.
  const folder = resolveFolderBySplat(folders, _splat)
  if (!folder) return <Navigate to="/documents" replace />

  return (
    <DocumentsView activeFolderId={folder.id} currentUser={user} focusedDocId={focus ?? null} />
  )
}
