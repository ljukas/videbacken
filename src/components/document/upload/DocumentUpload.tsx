import { forwardRef, type ReactNode, useCallback, useImperativeHandle } from 'react'
import { useDropzone } from 'react-dropzone'
import { toast } from 'sonner'
import { useUploadQueue } from '~/components/document/upload/UploadQueueProvider'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'

const MAX_BYTES = 100_000_000

type Props = {
  folderId: string | null
  children: ReactNode
  className?: string
}

export type DocumentUploadHandle = { open: () => void }

/**
 * Drop zone wrapping the document list. Dragging OS files anywhere over the list
 * enqueues them into the app-wide upload queue (see `UploadQueueProvider`), which
 * uploads one at a time and shows progress in a tray that persists across
 * navigation. This component only validates and hands files off; the file picker
 * is opened via the imperative `open()` handle (the trigger button lives in the
 * page toolbar).
 */
export const DocumentUpload = forwardRef<DocumentUploadHandle, Props>(function DocumentUpload(
  { folderId, children, className },
  ref,
) {
  const { enqueue } = useUploadQueue()

  const handleFiles = useCallback(
    (files: Array<File>) => {
      const accepted = files.filter((f) => {
        if (f.size > MAX_BYTES) {
          toast.error(m.upload_file_too_large({ name: f.name }))
          return false
        }
        return true
      })
      if (accepted.length === 0) return
      enqueue(accepted, folderId)
    },
    [folderId, enqueue],
  )

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop: handleFiles,
    noClick: true,
    noKeyboard: true,
  })

  useImperativeHandle(ref, () => ({ open }), [open])

  return (
    <div
      {...getRootProps()}
      className={cn(
        'relative rounded-lg transition-colors',
        isDragActive && 'outline-dashed outline-2 outline-ring outline-offset-4',
        className,
      )}
    >
      <input {...getInputProps()} />
      {isDragActive ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-background/80">
          <p className="font-medium text-sm">{m.upload_drop_hint()}</p>
        </div>
      ) : null}
      {children}
    </div>
  )
})
