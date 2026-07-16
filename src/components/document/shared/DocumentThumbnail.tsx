import { useQuery } from '@tanstack/react-query'
import { blurhashToCssGradientString } from '@unpic/placeholder'
import { useMemo } from 'react'
import { fileTypeAppearance } from '~/components/document/shared/documentHelpers'
import { SHARP_DECODABLE_MIME_SET } from '~/lib/image/blurhash'
import { orpc } from '~/lib/orpc/client'
import { cn } from '~/lib/utils'

type Props = {
  id: string
  mime: string
  extension?: string | null
  blurhash: string | null
  /**
   * The document's rendered-thumbnail path: `null` = not yet rendered, `''` =
   * render failed (sentinel), else a real path in the public store. The tile
   * fetches a thumbnail URL only when this is a real path.
   */
  thumbnailPathname: string | null
  className?: string
}

/**
 * Tile preview for a document. Documents with a rendered thumbnail (ADR-0010)
 * lazily fetch its public-store URL *after* render (so the grid paints
 * instantly) and load it directly as an <img>. The URL is stable, so the tile
 * loads once and never re-downloads. The blurhash, when present, paints behind
 * so the tile is never an empty box while the URL resolves — and stays as the
 * placeholder for images whose thumbnail isn't ready (or failed to render).
 * PDFs and other non-image mimes get a mime icon.
 */
export function DocumentThumbnail({
  id,
  mime,
  extension,
  blurhash,
  thumbnailPathname,
  className,
}: Props) {
  const isImage = SHARP_DECODABLE_MIME_SET.has(mime)
  const hasThumbnail = thumbnailPathname != null && thumbnailPathname !== ''
  const gradient = useMemo(
    () => (blurhash ? blurhashToCssGradientString(blurhash) : null),
    [blurhash],
  )

  const { data } = useQuery({
    ...orpc.document.thumbnail.queryOptions({ input: { id } }),
    enabled: hasThumbnail,
    // Public thumbnail URLs don't expire, so fetch once and keep it.
    staleTime: Number.POSITIVE_INFINITY,
  })

  if (!isImage) {
    const { Icon, className: iconClass } = fileTypeAppearance({ mime, extension })
    return (
      <div className={cn('flex items-center justify-center rounded-md bg-muted', className)}>
        <Icon aria-hidden="true" className={cn('size-1/2', iconClass)} />
      </div>
    )
  }

  return (
    <div
      className={cn('relative overflow-hidden rounded-md bg-muted', className)}
      style={gradient ? { backgroundImage: gradient } : undefined}
    >
      {data?.url ? (
        <img
          src={data.url}
          alt=""
          loading="lazy"
          decoding="async"
          className="size-full object-cover"
        />
      ) : null}
    </div>
  )
}
