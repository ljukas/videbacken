import { blurhashToCssGradientString } from '@unpic/placeholder'
import { Image } from '@unpic/react/base'
import { useMemo } from 'react'
import { snapBreakpoints } from '~/lib/image/sizes'
import { transformer } from '~/lib/image/transformer'
import { cn } from '~/lib/utils'

// Renders a public-store image at an on-demand size with a blurhash placeholder,
// routing the blob host through the unpic transformer (/_vercel/image). `src` MUST
// be a full public URL (e.g. coverUrl / photos[].url from the enriched reads), not a
// bare pathname. Shared by AvatarImage and the recommendation map/detail views.
export function BlurhashImage({
  src,
  alt,
  width,
  height,
  blurhash,
  className,
  onError,
  'data-slot': dataSlot,
}: {
  src: string
  alt: string
  width: number
  height: number
  blurhash?: string | null
  className?: string
  onError?: () => void
  'data-slot'?: string
}) {
  // Memoize the gradient string — blurhashToCssGradientString builds a multi-stop
  // CSS expression and we don't want it recomputed each render.
  const background = useMemo(
    () => (blurhash ? blurhashToCssGradientString(blurhash) : undefined),
    [blurhash],
  )
  return (
    <Image
      data-slot={dataSlot}
      src={src}
      alt={alt}
      width={width}
      height={height}
      background={background}
      layout="constrained"
      breakpoints={snapBreakpoints(width)}
      transformer={transformer}
      onError={onError}
      className={cn('object-cover', className)}
    />
  )
}
