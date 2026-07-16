import { useSuspenseQuery } from '@tanstack/react-query'
import { orpc } from '~/lib/orpc/client'

/**
 * The two suspense queries that back the documents library — the flat folder
 * tree and the documents in the active folder. Shared by the desktop and mobile
 * trees; the route loaders prime both, so these resolve from cache.
 */
export function useDocumentsData(activeFolderId: string | null) {
  const { data: folders } = useSuspenseQuery(orpc.folder.tree.queryOptions())
  const { data: visibleDocuments } = useSuspenseQuery(
    orpc.document.listDocuments.queryOptions({ input: { folderId: activeFolderId } }),
  )
  return { folders, visibleDocuments }
}
