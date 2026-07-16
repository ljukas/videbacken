import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  arrayMove,
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useMutation } from '@tanstack/react-query'
import { ImagePlusIcon, XIcon } from 'lucide-react'
import { memo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '~/components/ui/button'
import { Progress } from '~/components/ui/progress'
import { Skeleton } from '~/components/ui/skeleton'
import { Spinner } from '~/components/ui/spinner'
import { useIsIOS } from '~/hooks/useIsIOS'
import { runUploadFlow } from '~/lib/effects/storage/clientUpload'
import { readImageMetaFromFile } from '~/lib/files/exif'
import { imageAccept, isHeicFile } from '~/lib/image/heicMime'
import { client, orpc } from '~/lib/orpc/client'
import { UPLOAD_IMAGE_MIME } from '~/lib/orpc/imageUpload'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { type FormPhoto, photoKey } from './recommendationFormTypes'

const MAX_BYTES = 15_000_000

type UploadMime = (typeof UPLOAD_IMAGE_MIME)[number]
// Narrowing guard: confirms a raw `File.type` is one of the directly-uploadable
// MIME types, so the value flows into `mintImageUpload`'s typed `contentType`.
function isDirectMime(type: string): type is UploadMime {
  return (UPLOAD_IMAGE_MIME as readonly string[]).includes(type)
}

function uid(): string {
  // No crypto.randomUUID dependency needed; uniqueness only within this mount.
  return `p_${Math.random().toString(36).slice(2)}_${performance.now()}`
}

export function PhotoUploader({
  value,
  onChange,
  onExifLocation,
}: {
  value: FormPhoto[]
  onChange: (next: FormPhoto[]) => void
  onExifLocation?: (loc: { lat: number; lng: number }) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  // iOS Photos picker converts HEIC→JPEG when `accept` omits heic; elsewhere we
  // keep heic selectable and the server worker transcodes (see `imageAccept`).
  const accept = imageAccept(useIsIOS())
  // Transient per-upload progress %, keyed by localId — presentation only, NOT a
  // field value (mirrors AvatarUpload's local `progress`). Reordering/membership
  // live in the form field via `value`/`onChange`.
  const [progress, setProgress] = useState<Record<string, number>>({})
  const mintMutation = useMutation(orpc.recommendation.mintImageUpload.mutationOptions())

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  // `value` is captured per-call below via a ref so concurrent uploads append
  // correctly without stale closures.
  const valueRef = useRef(value)
  valueRef.current = value

  async function addFiles(files: File[]) {
    let exifReported = value.some((p) => p.kind === 'existing') // don't override on edit
    for (const raw of files) {
      if (valueRef.current.length >= 10) {
        toast.error(m.recommendation_photo_max())
        break
      }
      // Single EXIF pass on the RAW file (GPS + any embedded JPEG thumbnail).
      // No client transcode anymore — HEIC bytes upload as-is and the server
      // `heic_transcode` worker derives the displayable asset (ADR-0012 §4).
      const { gps, thumbnail } = await readImageMetaFromFile(raw)
      if (!exifReported && gps && onExifLocation) {
        onExifLocation(gps)
        exifReported = true
      }

      // Validate the RAW file — HEIC is now an accepted upload type (task 6).
      // iOS sometimes reports an empty `file.type` for `.heic`; coerce those to
      // `image/heic` (extension-aware via `isHeicFile`) so they pass the gate and
      // mint as HEIC rather than being rejected as "unsupported" (the feature's
      // whole point is to accept HEIC). Genuinely unsupported files still fall
      // through to the toast below.
      const contentType = isDirectMime(raw.type)
        ? raw.type
        : isHeicFile(raw)
          ? 'image/heic'
          : raw.type
      if (!isDirectMime(contentType)) {
        toast.error(m.recommendation_photo_unsupported())
        continue
      }
      if (raw.size > MAX_BYTES) {
        toast.error(m.recommendation_photo_too_large())
        continue
      }

      // Native iPhone HEICs carry NO extractable EXIF JPEG (their preview is an HEVC
      // `thmb` item), so `thumbnail` is normally null and the browser can't render
      // the bytes directly. For those we transcode a preview server-side (below),
      // showing a "processing" tile meanwhile; HEICs that DO carry an EXIF JPEG, and
      // all non-HEIC files, preview locally from their bytes.
      const isHeic = isHeicFile(raw)
      const needsServerPreview = isHeic && !thumbnail
      const previewUrl = isHeic
        ? thumbnail
          ? URL.createObjectURL(thumbnail)
          : ''
        : URL.createObjectURL(raw)

      const localId = uid()
      const slot: FormPhoto = {
        kind: 'new',
        localId,
        sizeBytes: raw.size,
        previewUrl,
        previewLoading: needsServerPreview,
        status: 'uploading',
      }
      onChange([...valueRef.current, slot])

      // Stateless server transcode → small JPEG data URL, concurrent with the
      // storage upload below. Fire-and-forget: on failure the tile keeps its
      // placeholder (the real image still lands after save via the worker).
      if (needsServerPreview) {
        void client.image
          .previewHeic({ file: raw })
          .then(({ dataUrl }) =>
            onChange(
              valueRef.current.map((p) =>
                p.kind === 'new' && p.localId === localId
                  ? { ...p, previewUrl: dataUrl, previewLoading: false }
                  : p,
              ),
            ),
          )
          .catch(() =>
            onChange(
              valueRef.current.map((p) =>
                p.kind === 'new' && p.localId === localId ? { ...p, previewLoading: false } : p,
              ),
            ),
          )
      }

      try {
        let pathname = ''
        await runUploadFlow(raw, {
          access: 'public',
          contentType,
          mint: async () => {
            const minted = await mintMutation.mutateAsync({
              contentType,
              sizeBytes: raw.size,
              name: raw.name,
            })
            pathname = minted.pathname
            return minted
          },
          confirm: async () => {}, // no confirm step — pathname is submitted with the form
          onProgress: (e) => setProgress((p) => ({ ...p, [localId]: e.percentage })),
        })
        onChange(
          valueRef.current.map((p) =>
            p.kind === 'new' && p.localId === localId ? { ...p, pathname, status: 'done' } : p,
          ),
        )
      } catch {
        toast.error(m.recommendation_photo_upload_error())
        onChange(
          valueRef.current.map((p) =>
            p.kind === 'new' && p.localId === localId ? { ...p, status: 'error' } : p,
          ),
        )
      } finally {
        setProgress((p) => {
          const { [localId]: _drop, ...rest } = p
          return rest
        })
      }
    }
    if (inputRef.current) inputRef.current.value = ''
  }

  function removeAt(key: string) {
    const target = value.find((p) => photoKey(p) === key)
    // previewUrl is '' for a HEIC with no embedded thumbnail (placeholder tile);
    // never revoke an empty string — it isn't an object URL.
    if (target?.kind === 'new' && target.previewUrl) URL.revokeObjectURL(target.previewUrl)
    onChange(value.filter((p) => photoKey(p) !== key))
  }

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const from = value.findIndex((p) => photoKey(p) === active.id)
    const to = value.findIndex((p) => photoKey(p) === over.id)
    if (from < 0 || to < 0) return
    onChange(arrayMove(value, from, to))
  }

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple
        className="sr-only"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (files.length) void addFiles(files)
        }}
      />
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={value.map(photoKey)} strategy={horizontalListSortingStrategy}>
          <div className="flex flex-wrap gap-3">
            {value.map((p, i) => (
              <PhotoTile
                key={photoKey(p)}
                photo={p}
                isCover={i === 0}
                progress={p.kind === 'new' ? progress[p.localId] : undefined}
                onRemove={() => removeAt(photoKey(p))}
              />
            ))}
            <Button
              type="button"
              variant="outline"
              onClick={() => inputRef.current?.click()}
              className="size-24 flex-col gap-1 border-dashed"
            >
              <ImagePlusIcon />
              <span className="text-xs">{m.recommendation_photo_add()}</span>
            </Button>
          </div>
        </SortableContext>
      </DndContext>
      <p className="text-muted-foreground text-xs">{m.recommendation_photos_hint()}</p>
    </div>
  )
}

// Memoized so reordering/uploading one tile doesn't re-render the whole strip:
// each tile only re-renders when its own photo/cover/progress identity changes.
const PhotoTile = memo(function PhotoTile({
  photo,
  isCover,
  progress,
  onRemove,
}: {
  photo: FormPhoto
  isCover: boolean
  progress: number | undefined
  onRemove: () => void
}) {
  const id = photoKey(photo)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  })
  const src = photo.kind === 'existing' ? photo.url : photo.previewUrl
  const uploading = photo.kind === 'new' && photo.status === 'uploading'
  const failed = photo.kind === 'new' && photo.status === 'error'
  const [imgLoaded, setImgLoaded] = useState(false)
  // An image is here or on its way (preview still decoding) — show the calm shimmer
  // rather than the neutral add-photo icon while we wait, and cross-fade it in on load.
  const expectImage = !!src || (photo.kind === 'new' && !!photo.previewLoading)
  // A new photo is still "preparing" until its preview has painted: the server HEIC
  // transcode (previewLoading) routinely finishes AFTER the upload, plus a brief paint
  // gap once the data URL is set. Keep the active spinner through all of it so HEIC
  // matches JPEG (continuous spinner → image) instead of flashing an empty square.
  const preparing = photo.kind === 'new' && (!!photo.previewLoading || (!!src && !imgLoaded))
  const busy = uploading || preparing
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'relative size-24 overflow-hidden rounded-lg border bg-muted',
        // Ease the tile in instead of popping (matches the dialog-content entrance);
        // motion-safe so reduced-motion users just get the tile.
        'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-200',
        isDragging && 'z-10 opacity-80',
      )}
      {...attributes}
      {...listeners}
    >
      {/* Calm shimmer while we await an image but nothing active is covering the tile —
          e.g. an existing photo still fetching from the network. New photos are covered by
          the spinner overlay (busy) instead, since a bg-muted shimmer on a bg-muted tile
          reads as an empty square. The image cross-fades in over it. */}
      {!imgLoaded && expectImage && !busy ? (
        <Skeleton className="absolute inset-0 size-full rounded-none" />
      ) : null}

      {/* Neutral placeholder only when no image is expected: a preview that failed, or an
          existing photo whose transcode left no displayable URL. */}
      {!expectImage ? (
        <div className="flex size-full items-center justify-center text-muted-foreground">
          <ImagePlusIcon className="size-8" />
        </div>
      ) : null}

      {/* Plain <img> on an object-/data-URL (no transformer for a local preview). Cross-fades
          in on load over the shimmer so there's no hard pop. The ref covers already-decoded
          data URLs whose `load` may fire before React attaches the handler. */}
      {src ? (
        <img
          ref={(el) => {
            if (el?.complete) setImgLoaded(true)
          }}
          src={src}
          alt=""
          onLoad={() => setImgLoaded(true)}
          // Treat a load failure as "settled" too, so a broken preview clears `busy`
          // instead of spinning forever (the placeholder/real image takes over).
          onError={() => setImgLoaded(true)}
          className={cn(
            'absolute inset-0 size-full object-cover motion-safe:transition-opacity motion-safe:duration-300 motion-safe:ease-out',
            imgLoaded ? 'opacity-100' : 'opacity-0',
          )}
        />
      ) : null}
      {isCover ? (
        <span className="absolute top-1 left-1 rounded bg-foreground/70 px-1.5 py-0.5 text-[10px] text-background">
          {m.recommendation_photo_cover()}
        </span>
      ) : null}
      {/* Upload/preparing overlay: a light scrim (lets the faded-in preview show through)
          that stays through both the upload AND the server preview decode (`busy`), then
          fades OUT as the image fades in — so HEIC shows a continuous spinner rather than an
          empty square. Kept mounted for new photos so the opacity can transition; aria-hidden
          when idle so the spinner isn't announced. */}
      {photo.kind === 'new' ? (
        <div
          aria-hidden={!busy}
          className={cn(
            'absolute inset-0 flex flex-col items-center justify-center gap-1 bg-foreground/25 text-background motion-safe:transition-opacity motion-safe:duration-200 motion-safe:ease-out',
            busy ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
        >
          <Spinner />
          {typeof progress === 'number' ? <Progress value={progress} className="w-16" /> : null}
        </div>
      ) : null}
      {failed ? (
        <div className="absolute inset-0 flex items-center justify-center bg-destructive/70 text-center text-[10px] text-background motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200">
          {m.recommendation_photo_failed()}
        </div>
      ) : null}
      <button
        type="button"
        aria-label={m.recommendation_photo_remove()}
        onClick={onRemove}
        onPointerDown={(e) => e.stopPropagation()} // don't start a drag from the remove button
        className="absolute top-1 right-1 rounded-full bg-foreground/70 p-1 text-background hover:bg-foreground"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  )
})
