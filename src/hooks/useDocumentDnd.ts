import {
  type ClientRect,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type DropAnimation,
  defaultDropAnimationSideEffects,
  KeyboardSensor,
  MouseSensor,
  pointerWithin,
  rectIntersection,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  type FolderRow,
  parseFolderDropId,
  planMixedDrop,
} from '~/components/document/shared/documentHelpers'
import { client, orpc, type RouterOutputs } from '~/lib/orpc/client'
import { optimisticPatch, optimisticRemove } from '~/lib/orpc/optimistic'
import { m } from '~/paraglide/messages'

/** A row as returned by `document.listDocuments` — derived so it can't drift. */
type DocumentRow = RouterOutputs['document']['listDocuments'][number]

// Default snap-back animates the ghost home to the source row, which reads as
// a bounce-back even on success. On a real move we instead shrink-and-fade the
// ghost into the dropped folder's center; empty-space drops keep the snap-back.
const transformToCss = (t: { x: number; y: number; scaleX: number; scaleY: number }) =>
  `translate3d(${t.x}px, ${t.y}px, 0) scaleX(${t.scaleX}) scaleY(${t.scaleY})`

/**
 * Owns the drag-and-drop behaviour of the documents library: the optimistic
 * (group) move, dnd-kit sensors, pointer/keyboard collision detection, the drag
 * handlers, and the fly-into-folder drop animation. `DocumentsView` supplies the
 * URL-resolved folder, the documents in view, the current selection, and a
 * selection-clear callback, and spreads the returned props onto its
 * `<DndContext>` / `<DragOverlay>`. The whole file row is the drag activator
 * (the per-row `useDraggable` lives in `DocumentTable`); dragging a row that's
 * part of the selection moves the whole selection.
 */
type ActiveDrag = { kind: 'document'; id: string } | { kind: 'folder'; id: string }

export function useDocumentDnd({
  activeFolderId,
  visibleDocuments,
  folders,
  selectedDocIds,
  selectedFolderIds,
  isAdmin,
  clearSelection,
}: {
  /** Resolved folder id from the URL, or null for the virtual root. */
  activeFolderId: string | null
  visibleDocuments: ReadonlyArray<DocumentRow>
  /** The flat folder tree — for the folder drag ghost + descendant guard. */
  folders: ReadonlyArray<FolderRow>
  /** Selected document ids (a drag that starts on one of these moves the selection). */
  selectedDocIds: ReadonlyArray<string>
  /** Selected folder ids (admin-only; a drag on one moves the whole mixed selection). */
  selectedFolderIds: ReadonlyArray<string>
  isAdmin: boolean
  clearSelection: () => void
}) {
  const queryClient = useQueryClient()

  // A drag carries either a document or a folder, discriminated by
  // `event.active.data`. A drag starting on a *selected* row carries the whole
  // mixed selection (docs + folders).
  const [active, setActive] = useState<ActiveDrag | null>(null)
  const activeDoc =
    active?.kind === 'document' ? visibleDocuments.find((d) => d.id === active.id) : undefined
  const activeFolder =
    active?.kind === 'folder' ? folders.find((f) => f.id === active.id) : undefined
  // How many items the active drag carries: the whole selection when the dragged
  // row is part of it, else just the one. 0 when idle.
  const totalSelected = selectedDocIds.length + selectedFolderIds.length
  const activeCount = !active
    ? 0
    : active.kind === 'document'
      ? selectedDocIds.includes(active.id)
        ? totalSelected
        : 1
      : isAdmin && selectedFolderIds.includes(active.id)
        ? totalSelected
        : 1
  // Set on a successful drop so the drop animation flies the ghost into the
  // target folder instead of snapping back to the source row. Null = no move.
  const dropTargetRect = useRef<ClientRect | null>(null)

  // Mouse drags after a 6px move (so a click selects / a double-click opens
  // without dragging). Touch needs a 200ms press-hold to start — a quick swipe
  // under the tolerance scrolls the list instead. Keyboard keeps drag a11y.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  )

  // For a pointer drag the cursor is the source of truth: `pointerWithin`
  // highlights only the folder actually under the cursor and returns nothing
  // otherwise (so dropping in empty space is a clean no-op). A rect-based
  // fallback is wrong here — the drag overlay inherits the full row width, so
  // `rectIntersection` would always pick the rightmost folder. Only the
  // keyboard sensor, which has no pointer, needs that rect-based fallback.
  const collisionDetection = useCallback<CollisionDetection>(
    (args) => (args.pointerCoordinates ? pointerWithin(args) : rectIntersection(args)),
    [],
  )

  // No batch endpoint: drop all moved ids from the source list once, fan out
  // single moves in parallel, then reconcile + toast once (looping a mutation
  // with its own callbacks would toast and invalidate N times).
  const runMove = useCallback(
    async (ids: Array<string>, folderId: string | null) => {
      const idSet = new Set(ids)
      await optimisticRemove(
        queryClient,
        orpc.document.listDocuments.queryKey({ input: { folderId: activeFolderId } }),
        (doc) => idSet.has(doc.id),
      )
      const results = await Promise.allSettled(
        ids.map((id) => client.document.moveDocument({ id, folderId })),
      )
      await queryClient.invalidateQueries({ queryKey: orpc.document.listDocuments.key() })
      const failed = results.filter((r) => r.status === 'rejected').length
      if (failed === 0) {
        toast.success(
          ids.length === 1
            ? m.document_moved_single_toast()
            : m.document_moved_count_toast({ count: ids.length }),
        )
        clearSelection()
      } else {
        toast.error(m.document_move_failed_partial({ failed, count: ids.length }))
      }
    },
    [queryClient, activeFolderId, clearSelection],
  )

  // Folder move reuses the existing admin-only `folder.moveFolder` (which
  // cascades descendant paths + rebuilds document haystacks server-side).
  // Optimistically re-parent the folder so it leaves the current view's child
  // list immediately; the `finally` invalidate reconciles the authoritative
  // tree (paths, descendants) and reverts on error — so no need to recompute
  // paths here.
  const runFolderMove = useCallback(
    async (id: string, newParentId: string | null) => {
      await optimisticPatch(
        queryClient,
        orpc.folder.tree.queryKey(),
        (f) => f.id === id,
        (f) => ({ ...f, parentId: newParentId }),
      )

      try {
        await client.folder.moveFolder({ id, newParentId })
        toast.success(m.folder_moved_toast())
      } catch (err) {
        toast.error(err instanceof Error ? err.message : m.folder_move_error())
      } finally {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.folder.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.document.listDocuments.key() }),
        ])
      }
    },
    [queryClient],
  )

  // Group move of a mixed selection: one optimistic pass (drop docs from the
  // source list, re-parent folders in the tree), one fan-out of single moves,
  // one reconcile, one combined toast — same no-batch pattern as `runMove`.
  const runMixedMove = useCallback(
    async (docIds: Array<string>, folderIds: Array<string>, target: string | null) => {
      const docSet = new Set(docIds)
      const folderSet = new Set(folderIds)
      await optimisticRemove(
        queryClient,
        orpc.document.listDocuments.queryKey({ input: { folderId: activeFolderId } }),
        (doc) => docSet.has(doc.id),
      )
      await optimisticPatch(
        queryClient,
        orpc.folder.tree.queryKey(),
        (f) => folderSet.has(f.id),
        (f) => ({ ...f, parentId: target }),
      )
      const results = await Promise.allSettled([
        ...docIds.map((id) => client.document.moveDocument({ id, folderId: target })),
        ...folderIds.map((id) => client.folder.moveFolder({ id, newParentId: target })),
      ])
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: orpc.folder.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.document.listDocuments.key() }),
      ])
      const total = docIds.length + folderIds.length
      const failed = results.filter((r) => r.status === 'rejected').length
      if (failed === 0) {
        toast.success(
          total === 1
            ? m.document_item_moved_toast()
            : m.document_items_moved_toast({ count: total }),
        )
        clearSelection()
      } else {
        toast.error(m.document_move_failed_partial({ failed, count: total }))
      }
    },
    [queryClient, activeFolderId, clearSelection],
  )

  const onDragStart = useCallback((event: DragStartEvent) => {
    dropTargetRect.current = null
    const data = event.active.data.current
    if (data?.documentId) setActive({ kind: 'document', id: data.documentId as string })
    else if (data?.folderId) setActive({ kind: 'folder', id: data.folderId as string })
    else setActive(null)
  }, [])

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      dropTargetRect.current = null
      const data = event.active.data.current
      const over = event.over
      if (over) {
        const target = parseFolderDropId(String(over.id))
        const dragged = data?.documentId
          ? ({ kind: 'document', id: data.documentId as string } as const)
          : data?.folderId
            ? ({ kind: 'folder', id: data.folderId as string } as const)
            : null
        if (target !== undefined && dragged) {
          const plan = planMixedDrop({
            dragged,
            target,
            selectedDocIds,
            selectedFolderIds,
            visibleDocuments,
            folders,
            isAdmin,
          })
          // Real moves fly the ghost into the dropped target rather than snap back.
          if (plan.kind === 'single-doc') {
            dropTargetRect.current = over.rect
            void runMove([plan.id], target)
          } else if (plan.kind === 'single-folder') {
            dropTargetRect.current = over.rect
            void runFolderMove(plan.id, target)
          } else if (plan.kind === 'mixed') {
            dropTargetRect.current = over.rect
            void runMixedMove(plan.docIds, plan.folderIds, target)
          } else if (plan.kind === 'abort') {
            toast.error(m.document_move_into_selected_error())
          }
          // 'none' → no-op (already in target / nothing legal): snap back, no toast.
        }
      }
      setActive(null)
    },
    [
      selectedDocIds,
      selectedFolderIds,
      visibleDocuments,
      folders,
      isAdmin,
      runMove,
      runFolderMove,
      runMixedMove,
    ],
  )

  const onDragCancel = useCallback(() => setActive(null), [])

  const dropAnimation = useMemo<DropAnimation>(
    () => ({
      duration: 220,
      easing: 'ease-out',
      sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: '0' } } }),
      keyframes: ({ transform, dragOverlay }) => {
        const target = dropTargetRect.current
        // dnd-kit sizes the overlay wrapper to the full-width source row, so the
        // visible card sits at the wrapper's left edge. Anchor the fly-in on the
        // card itself (translate its centre onto the folder, scale toward it).
        const card = dragOverlay.node?.querySelector<HTMLElement>('[data-drag-card]')
        if (!target || !card) {
          return [
            { transform: transformToCss(transform.initial) },
            { transform: transformToCss(transform.final) },
          ]
        }
        const wrapper = dragOverlay.node.getBoundingClientRect()
        const cardBox = card.getBoundingClientRect()
        const cardCx = cardBox.left + cardBox.width / 2
        const cardCy = cardBox.top + cardBox.height / 2
        const finalX = transform.initial.x + (target.left + target.width / 2 - cardCx)
        const finalY = transform.initial.y + (target.top + target.height / 2 - cardCy)
        // transform-origin (wrapper-local) at the card centre so the shrink
        // collapses onto the folder, not onto the wide wrapper's centre.
        const origin = `${cardCx - wrapper.left}px ${cardCy - wrapper.top}px`
        return [
          { transformOrigin: origin, opacity: 1, transform: transformToCss(transform.initial) },
          {
            transformOrigin: origin,
            opacity: 0,
            transform: `translate3d(${finalX}px, ${finalY}px, 0) scale(0.12)`,
          },
        ]
      },
    }),
    [],
  )

  return {
    /** Spread onto `<DndContext>`. */
    dndContextProps: { sensors, collisionDetection, onDragStart, onDragEnd, onDragCancel },
    /** The document under the active drag, for the `<DragOverlay>` ghost (undefined when idle). */
    activeDoc,
    /** The folder under the active drag, for the `<DragOverlay>` ghost (undefined when idle). */
    activeFolder,
    /** How many documents the active drag carries (for the overlay count badge). */
    activeCount,
    /** Fly-into-folder drop animation config for `<DragOverlay>`. */
    dropAnimation,
  }
}
