// Single source of truth for the Vercel image-optimizer allow-list. Both
// `vite.config.ts` (Build Output `images.sizes`) and the runtime
// `snapBreakpoints` helper read from here, so the buckets the optimizer
// accepts and the widths components actually request can't drift.
export const IMAGE_SIZES = [
  16, 32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840,
] as const

export function snapWidthUp(desired: number): number {
  for (const size of IMAGE_SIZES) {
    if (size >= desired) return size
  }
  return IMAGE_SIZES[IMAGE_SIZES.length - 1]
}

// 1× and 2× DPR widths for a `<Image layout="constrained">` srcset, each
// snapped up to the nearest allowed bucket. unpic filters constrained
// breakpoints to `≤ width × maxDPR` (default 3), so both values land in
// srcset for normal display sizes.
export function snapBreakpoints(width: number): number[] {
  const oneX = snapWidthUp(width)
  const twoX = snapWidthUp(width * 2)
  return oneX === twoX ? [oneX] : [oneX, twoX]
}
