import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  type CurrentUser,
  type DocumentRow,
  type FolderRow,
  parseSelKey,
} from '~/components/document/shared/documentHelpers'

/**
 * The documents library's selection model, shared by the desktop and mobile
 * trees so both branch identically. Holds one `Set<string>` of composite keys
 * (`seldoc:` / `selfolder:`) — files and folders mixed in a single
 * non-discriminating selection — and derives the per-kind id arrays, the
 * "may act on everything selected" gate, and a clear helper. Selection that
 * leaves the view (items moved/deleted, folders no longer children of the
 * active folder, or a realtime invalidate) is pruned reactively.
 *
 * Extracted from the old inline `DocumentsView` body; the desktop table keeps
 * its own cosmetic single-folder highlight for non-admins separately (folder
 * ops are admin-only, so non-admin folders never enter this Set).
 */
export function useDocumentSelection({
  visibleDocuments,
  folders,
  activeFolderId,
  currentUser,
}: {
  visibleDocuments: ReadonlyArray<DocumentRow>
  folders: ReadonlyArray<FolderRow>
  activeFolderId: string | null
  currentUser: CurrentUser
}) {
  const isAdmin = currentUser.role === 'admin'
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const clearSelection = useCallback(() => setSelected(new Set()), [])

  const selectedDocIds = useMemo(
    () =>
      [...selected].flatMap((key) => {
        const parsed = parseSelKey(key)
        return parsed?.kind === 'document' ? [parsed.id] : []
      }),
    [selected],
  )
  const selectedFolderIds = useMemo(
    () =>
      [...selected].flatMap((key) => {
        const parsed = parseSelKey(key)
        return parsed?.kind === 'folder' ? [parsed.id] : []
      }),
    [selected],
  )

  // Drop keys that leave the view — items moved/deleted/renamed, or a realtime
  // invalidate. Folder keys are pruned when they're no longer a child of the
  // active folder, which also clears them on navigation.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev
      const validDocs = new Set(visibleDocuments.map((d) => d.id))
      const validFolders = new Set(
        folders.filter((f) => f.parentId === activeFolderId).map((f) => f.id),
      )
      let changed = false
      const next = new Set<string>()
      for (const key of prev) {
        const parsed = parseSelKey(key)
        const valid =
          parsed?.kind === 'document'
            ? validDocs.has(parsed.id)
            : parsed?.kind === 'folder'
              ? validFolders.has(parsed.id)
              : false
        if (valid) next.add(key)
        else changed = true
      }
      return changed ? next : prev
    })
  }, [visibleDocuments, folders, activeFolderId])

  // Every selected doc editable by the user, and — since folder move/delete are
  // admin-only — no folders selected unless admin.
  const canActOnAll = useMemo(() => {
    if (selectedDocIds.length + selectedFolderIds.length === 0) return false
    const docsOk = selectedDocIds.every((id) => {
      const d = visibleDocuments.find((v) => v.id === id)
      return !!d && (d.ownerId === currentUser.id || currentUser.role === 'admin')
    })
    return docsOk && (selectedFolderIds.length === 0 || isAdmin)
  }, [selectedDocIds, selectedFolderIds, visibleDocuments, currentUser, isAdmin])

  return {
    isAdmin,
    selected,
    setSelected,
    selectedDocIds,
    selectedFolderIds,
    canActOnAll,
    clearSelection,
  }
}
