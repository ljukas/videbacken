import { useAsyncQueuer } from '@tanstack/react-pacer/async-queuer'
import { useQueryClient } from '@tanstack/react-query'
import { createContext, type PropsWithChildren, use, useCallback, useState } from 'react'
import { runUploadFlow } from '~/lib/effects/storage/clientUpload'
import { client, orpc } from '~/lib/orpc/client'

/** One row in the upload tray — the render model, kept separate from the raw `File`. */
export type UploadItem = {
  id: string
  name: string
  sizeBytes: number
  loaded: number
  status: 'pending' | 'uploading' | 'done' | 'error'
}

/** The unit of work the queuer drains: the file plus the folder captured at enqueue time. */
type UploadTask = { id: string; file: File; folderId: string | null }

type UploadQueueValue = {
  items: Array<UploadItem>
  /** Enqueue files into the current folder. They upload one at a time, FIFO. */
  enqueue: (files: Array<File>, folderId: string | null) => void
  /** Drop settled (done/error) rows, leaving anything still pending/uploading. */
  dismiss: () => void
}

const UploadQueueContext = createContext<UploadQueueValue | null>(null)

/**
 * App-wide, page-persistent document upload queue. Mounted in the authenticated
 * layout (which never unmounts during in-app navigation) so a big batch keeps
 * uploading while the user moves around the site.
 *
 * TanStack Pacer's `useAsyncQueuer` is the execution engine: `concurrency: 1`
 * means strictly one upload in flight (so we don't flood slow connections), and
 * `asyncRetryerOptions` retries transient failures with backoff. The byte-level
 * progress aggregation and the tray itself stay custom — Pacer tracks task
 * lifecycle, not sub-task `onUploadProgress` — so this provider owns the `items`
 * render model and `UploadQueueBox` reads it.
 */
export function UploadQueueProvider({ children }: PropsWithChildren) {
  const queryClient = useQueryClient()
  const [items, setItems] = useState<Array<UploadItem>>([])

  const patch = useCallback((id: string, next: Partial<UploadItem>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...next } : it)))
  }, [])

  const queuer = useAsyncQueuer<UploadTask>(
    async ({ id, file, folderId }) => {
      const contentType = file.type || 'application/octet-stream'
      patch(id, { status: 'uploading', loaded: 0 })
      await runUploadFlow(file, {
        access: 'private',
        contentType,
        mint: () =>
          client.document.mintDocumentUpload({
            contentType,
            sizeBytes: file.size,
            name: file.name,
          }),
        confirm: (mint) =>
          client.document.confirmDocumentUpload({
            pathname: mint.pathname,
            name: file.name,
            sizeBytes: file.size,
            folderId,
          }),
        onProgress: (p) => patch(id, { loaded: p.loaded, sizeBytes: p.total || file.size }),
      })
    },
    {
      concurrency: 1,
      // Resilience for flaky/slow connections. A retry only fires when the task
      // threw, i.e. `confirm` never ran (it's the last await), so no duplicate
      // document rows — at worst an unreferenced orphan blob from a prior attempt.
      asyncRetryerOptions: { maxAttempts: 3, backoff: 'exponential' },
      onSuccess: (_result, item) => {
        patch(item.id, { status: 'done', loaded: item.file.size })
        // Immediate refresh of the active folder; confirmDocumentUpload also
        // publishes `document.changed`, which useRealtimeSync invalidates too.
        void queryClient.invalidateQueries({ queryKey: orpc.document.listDocuments.key() })
      },
      onError: (_error, item) => patch(item.id, { status: 'error' }),
    },
  )

  const enqueue = useCallback(
    (files: Array<File>, folderId: string | null) => {
      const tasks: Array<UploadTask> = files.map((file) => ({
        id: crypto.randomUUID(),
        file,
        folderId,
      }))
      setItems((prev) => [
        ...prev,
        ...tasks.map((t) => ({
          id: t.id,
          name: t.file.name,
          sizeBytes: t.file.size,
          loaded: 0,
          status: 'pending' as const,
        })),
      ])
      for (const task of tasks) queuer.addItem(task)
    },
    [queuer],
  )

  const dismiss = useCallback(() => {
    setItems((prev) => prev.filter((it) => it.status === 'pending' || it.status === 'uploading'))
  }, [])

  return <UploadQueueContext value={{ items, enqueue, dismiss }}>{children}</UploadQueueContext>
}

export function useUploadQueue(): UploadQueueValue {
  const value = use(UploadQueueContext)
  if (!value) throw new Error('useUploadQueue must be used within an UploadQueueProvider')
  return value
}
