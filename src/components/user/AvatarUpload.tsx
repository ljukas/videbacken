import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { ImageUpIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Avatar, AvatarFallback, AvatarImage } from '~/components/ui/avatar'
import { Button } from '~/components/ui/button'
import { Progress } from '~/components/ui/progress'
import { Spinner } from '~/components/ui/spinner'
import { useIsIOS } from '~/hooks/useIsIOS'
import { runUploadFlow, type UploadProgress } from '~/lib/effects/storage/clientUpload'
import { readImageMetaFromFile } from '~/lib/files/exif'
import { imageAccept, isHeicFile } from '~/lib/image/heicMime'
import { orpc } from '~/lib/orpc/client'
import { cn, initials } from '~/lib/utils'
import { m } from '~/paraglide/messages'

const DIRECT_UPLOAD_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'] as const
type DirectUploadMime = (typeof DIRECT_UPLOAD_MIME)[number]
const MAX_BYTES = 5_000_000

function formatBytes(n: number) {
  if (n < 1000) return `${n} B`
  if (n < 1_000_000) return `${Math.round(n / 1000)} kB`
  return `${(n / 1_000_000).toFixed(1)} MB`
}

function isDirectUploadMime(t: string): t is DirectUploadMime {
  return (DIRECT_UPLOAD_MIME as readonly string[]).includes(t)
}

type Props = {
  // Optional: notified whenever the upload flow (mint → PUT → confirm) starts or
  // stops, so a parent (e.g. the onboarding avatar step) can block navigation
  // that would drop an in-flight image. Existing callers omit it and are
  // unaffected.
  onUploadingChange?: (uploading: boolean) => void
  // Presentation. `default` (avatar + Change button + progress/hint) is the
  // stand-alone layout used by onboarding. `row` is a compact clickable avatar
  // for a settings row (ProfileCard) — same upload logic, no inline button/bar.
  variant?: 'default' | 'row'
}

export function AvatarUpload({ onUploadingChange, variant = 'default' }: Props = {}) {
  const queryClient = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  // iOS Photos picker converts HEIC→JPEG when `accept` omits heic; elsewhere we
  // keep heic selectable and the server worker transcodes (see `imageAccept`).
  const accept = imageAccept(useIsIOS())
  const [progress, setProgress] = useState<UploadProgress | null>(null)
  // Best-effort local preview during the upload window: the EXIF-embedded JPEG
  // thumbnail (object URL) when the file carries one. Native iPhone HEICs usually
  // DON'T (their preview is an HEVC `thmb` item), so this is normally null and we
  // simply keep showing the current avatar / initials until the server transcode
  // lands and `user.changed` realtime invalidation swaps in the new image.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)

  const { data: me } = useSuspenseQuery(orpc.user.me.queryOptions())

  const mintMutation = useMutation(orpc.image.mintAvatarUpload.mutationOptions())
  const confirmMutation = useMutation(orpc.image.confirmAvatarUpload.mutationOptions())

  // Revoke any outstanding preview object URL on unmount.
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl])

  async function handleFile(rawFile: File) {
    let localPreview: string | null = null
    try {
      if (rawFile.size > MAX_BYTES) {
        toast.error(m.avatar_error_too_large())
        return
      }

      // No client transcode anymore — HEIC bytes upload as-is and the server
      // `heic_transcode` worker derives the displayable JPEG. iOS sometimes
      // reports an empty `file.type` for `.heic`; coerce those to `image/heic`
      // (extension-aware via `isHeicFile`) so they pass the gate and mint as
      // HEIC rather than being rejected. Genuinely unsupported files still fall
      // through to the toast below.
      const contentType = isDirectUploadMime(rawFile.type)
        ? rawFile.type
        : isHeicFile(rawFile)
          ? 'image/heic'
          : rawFile.type
      if (!isDirectUploadMime(contentType)) {
        toast.error(m.avatar_error_unsupported_format())
        return
      }

      // Best-effort local preview from the embedded EXIF JPEG thumbnail (if any).
      // Usually null for native iPhone HEICs — see the `previewUrl` state note.
      const { thumbnail } = await readImageMetaFromFile(rawFile)
      if (thumbnail) {
        localPreview = URL.createObjectURL(thumbnail)
        setPreviewUrl(localPreview)
      }

      setProgress({ loaded: 0, total: rawFile.size, percentage: 0 })
      await runUploadFlow(rawFile, {
        access: 'public',
        contentType,
        mint: () =>
          mintMutation.mutateAsync({
            contentType,
            sizeBytes: rawFile.size,
            name: rawFile.name,
          }),
        confirm: (mint) =>
          confirmMutation.mutateAsync({
            pathname: mint.pathname,
            name: rawFile.name,
            sizeBytes: rawFile.size,
          }),
        onProgress: (e) => setProgress(e),
      })

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: orpc.user.me.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.user.list.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.user.listContacts.key() }),
      ])
      toast.success(m.avatar_updated())
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.avatar_upload_error())
    } finally {
      setProgress(null)
      // Drop the local preview now that the real image (or initials fallback) is
      // authoritative; revoke the object URL to free it.
      if (localPreview) {
        URL.revokeObjectURL(localPreview)
        setPreviewUrl((cur) => (cur === localPreview ? null : cur))
      }
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const busy = progress !== null

  // Report upload-in-progress to an opt-in parent. The effect (not an inline
  // call) keeps the notification out of render and fires only when `busy` flips.
  useEffect(() => {
    onUploadingChange?.(busy)
  }, [busy, onUploadingChange])

  // During the upload window prefer the local EXIF preview (when present);
  // otherwise the current avatar. Falls back to initials when neither exists.
  const displaySrc = previewUrl ?? me.image

  const fileInput = (
    <input
      ref={inputRef}
      type="file"
      accept={accept}
      className="sr-only"
      onChange={(e) => {
        const f = e.target.files?.[0]
        if (f) void handleFile(f)
      }}
    />
  )

  // Compact settings-row presentation: a single clickable avatar with a
  // hover/busy overlay. `type="button"` so it never submits the surrounding
  // ProfileCard form. Format hint + toasts are owned by the row / handleFile.
  if (variant === 'row') {
    return (
      <>
        {fileInput}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          aria-label={me.image ? m.avatar_change_button() : m.avatar_add_button()}
          className="group relative w-fit rounded-full outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:pointer-events-none"
        >
          <Avatar className="size-14 shadow-sm">
            {displaySrc ? (
              <AvatarImage
                src={displaySrc}
                alt={me.name}
                width={56}
                height={56}
                blurhash={previewUrl ? undefined : me.imageBlurhash}
              />
            ) : null}
            <AvatarFallback className="font-medium">{initials(me.name)}</AvatarFallback>
          </Avatar>
          <span
            className={cn(
              'absolute inset-0 flex items-center justify-center rounded-full bg-foreground/45 text-background transition-opacity',
              busy
                ? 'opacity-100'
                : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
            )}
          >
            {busy ? <Spinner /> : <ImageUpIcon className="size-5" />}
          </span>
        </button>
      </>
    )
  }

  return (
    <div className="flex items-center gap-4">
      <Avatar className="size-20 shadow-sm">
        {displaySrc ? (
          <AvatarImage
            src={displaySrc}
            alt={me.name}
            width={80}
            height={80}
            blurhash={previewUrl ? undefined : me.imageBlurhash}
          />
        ) : null}
        <AvatarFallback className="font-medium text-lg">{initials(me.name)}</AvatarFallback>
      </Avatar>
      <div className="flex flex-col gap-2">
        {fileInput}
        <Button
          variant="outline"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="w-fit"
        >
          {busy ? <Spinner data-icon="inline-start" /> : <ImageUpIcon />}
          {me.image ? m.avatar_change_button() : m.avatar_add_button()}
        </Button>
        {progress !== null ? (
          <div className="flex w-56 flex-col gap-1">
            <Progress value={progress.percentage} aria-label={m.avatar_uploading_label()} />
            <div className="flex justify-between text-muted-foreground text-xs tabular-nums">
              <span>{progress.percentage} %</span>
              <span>
                {m.avatar_bytes_remaining({
                  amount: formatBytes(Math.max(progress.total - progress.loaded, 0)),
                })}
              </span>
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">{m.avatar_format_hint()}</p>
        )}
      </div>
    </div>
  )
}
