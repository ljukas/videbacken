import { Avatar as AvatarPrimitive } from 'radix-ui'
import type * as React from 'react'
import { useState } from 'react'

import { BlurhashImage } from '~/components/ui/blurhash-image'
import { cn } from '~/lib/utils'

function Avatar({
  className,
  size = 'default',
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Root> & {
  size?: 'default' | 'sm' | 'lg'
}) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      data-size={size}
      className={cn(
        // Base box: round, non-shrinking, default size
        'group/avatar relative flex size-8 shrink-0 select-none rounded-full',
        // after: ring overlay — borderless ring blended over the image so it
        // stays visible on light/dark backgrounds (darken in light, lighten in dark)
        'after:pointer-events-none after:absolute after:inset-0 after:rounded-full after:border after:border-border after:mix-blend-darken dark:after:mix-blend-lighten',
        // Size variants driven by data-size on the root
        'data-[size=lg]:size-10 data-[size=sm]:size-6',
        className,
      )}
      {...props}
    />
  )
}

// Bypasses Radix `AvatarPrimitive.Image` deliberately: Radix preloads `src` via
// a parallel JS `Image()` before mounting the real `<img>`, which would force a
// second request to the raw Blob URL on top of unpic's optimized one. We render
// the unpic Image directly with absolute positioning, layered over the
// permanent fallback — so the image covers it on success, and `onError` removes
// the img to reveal the fallback again.
function AvatarImage({
  className,
  src,
  alt,
  width,
  height,
  blurhash,
}: {
  className?: string
  src: string
  alt: string
  width: number
  height: number
  blurhash?: string | null
}) {
  const [hasError, setHasError] = useState(false)

  if (hasError) return null
  return (
    <BlurhashImage
      data-slot="avatar-image"
      src={src}
      alt={alt}
      width={width}
      height={height}
      blurhash={blurhash}
      onError={() => setHasError(true)}
      // Layered over the permanent fallback, filling the avatar box (object-cover
      // comes from BlurhashImage).
      className={cn('absolute inset-0 size-full rounded-full', className)}
    />
  )
}

function AvatarFallback({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn(
        // Centered initials filling the avatar box
        'flex size-full items-center justify-center rounded-full bg-muted text-muted-foreground text-sm',
        // Smaller text when the avatar is small
        'group-data-[size=sm]/avatar:text-xs',
        className,
      )}
      {...props}
    />
  )
}

function AvatarBadge({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="avatar-badge"
      className={cn(
        // Badge dot pinned to the bottom-right corner, ringed against the background
        'absolute right-0 bottom-0 z-10 inline-flex select-none items-center justify-center rounded-full bg-primary text-primary-foreground bg-blend-color ring-2 ring-background',
        // sm avatar: tiny dot, hide any svg child (no room for an icon)
        'group-data-[size=sm]/avatar:size-2 group-data-[size=sm]/avatar:[&>svg]:hidden',
        // default avatar: badge + icon sizing
        'group-data-[size=default]/avatar:size-2.5 group-data-[size=default]/avatar:[&>svg]:size-2',
        // lg avatar: badge + icon sizing
        'group-data-[size=lg]/avatar:size-3 group-data-[size=lg]/avatar:[&>svg]:size-2',
        className,
      )}
      {...props}
    />
  )
}

function AvatarGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="avatar-group"
      className={cn(
        // Row of overlapping avatars (negative gap), each child ringed against the background
        'group/avatar-group flex -space-x-2 *:data-[slot=avatar]:ring-2 *:data-[slot=avatar]:ring-background',
        className,
      )}
      {...props}
    />
  )
}

function AvatarGroupCount({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="avatar-group-count"
      className={cn(
        // Overflow counter chip matching avatar shape, ringed against the background
        'relative flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground text-sm ring-2 ring-background',
        // Chip size follows the group's avatar size
        'group-has-data-[size=lg]/avatar-group:size-10 group-has-data-[size=sm]/avatar-group:size-6',
        // svg child sizing, also scaled to the group's avatar size
        '[&>svg]:size-4 group-has-data-[size=lg]/avatar-group:[&>svg]:size-5 group-has-data-[size=sm]/avatar-group:[&>svg]:size-3',
        className,
      )}
      {...props}
    />
  )
}

export { Avatar, AvatarBadge, AvatarFallback, AvatarGroup, AvatarGroupCount, AvatarImage }
