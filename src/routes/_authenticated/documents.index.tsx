import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { DocumentsView } from '~/components/document/views/DocumentsView'
import { orpc } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

// `focus` = a document id the command palette navigated to; it scrolls the row
// into view and flashes a brand ring. Persisted in the URL so a refresh re-runs it.
const documentsSearchSchema = z.object({ focus: z.string().optional() })

export const Route = createFileRoute('/_authenticated/documents/')({
  head: () => ({
    meta: seo({
      title: `${m.meta_documents_title()} | Oceanview`,
      description: m.meta_documents_description(),
    }),
  }),
  validateSearch: documentsSearchSchema,
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      queryClient.ensureQueryData(orpc.folder.tree.queryOptions()),
      queryClient.ensureQueryData(
        orpc.document.listDocuments.queryOptions({ input: { folderId: null } }),
      ),
    ])
  },
  component: DocumentsRoot,
})

function DocumentsRoot() {
  const { user } = Route.useRouteContext()
  const focus = Route.useSearch({ select: (s) => s.focus })
  return <DocumentsView activeFolderId={null} currentUser={user} focusedDocId={focus ?? null} />
}
