/**
 * Render a small WebP preview from raw image bytes. Imports `sharp`
 * dynamically (same reasoning as `generateBlurhash`): the heavy native
 * module only loads in the queue consumer that calls this, never in the
 * producer routes that merely import the wrapper.
 *
 * `.rotate()` with no argument applies the EXIF orientation tag so portrait
 * photos aren't rendered sideways. `withoutEnlargement` keeps already-small
 * images at their native size rather than upscaling. The gate on which mimes
 * are worth rendering lives at the call site via `SHARP_DECODABLE_MIME_SET`
 * (see `./blurhash`).
 */
export const THUMBNAIL_MAX_EDGE = 400
export const THUMBNAIL_WEBP_QUALITY = 75

export async function generateImageThumbnail(imageBuffer: Buffer): Promise<Buffer> {
  const { default: sharp } = await import('sharp')

  return sharp(imageBuffer)
    .rotate()
    .resize(THUMBNAIL_MAX_EDGE, THUMBNAIL_MAX_EDGE, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: THUMBNAIL_WEBP_QUALITY })
    .toBuffer()
}
