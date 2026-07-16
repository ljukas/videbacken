/**
 * Mimes the sharp prebuilt binary can decode. HEIC needs libheif which
 * the prebuilt binary omits, so we exclude it. The shared constant gates
 * both the document-upload producer (avoid no-op enqueues) and the
 * Nitro queue consumer (clean skip on undecodable rows).
 */
export const SHARP_DECODABLE_MIMES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/avif',
] as const

export const SHARP_DECODABLE_MIME_SET: ReadonlySet<string> = new Set(SHARP_DECODABLE_MIMES)

/**
 * Generate a blurhash placeholder string from raw image bytes. Imports
 * `sharp` and `blurhash` dynamically so neither lands in any bundle that
 * doesn't actually call this function — the queue consumer pays the load
 * cost; producer routes don't.
 */
export async function generateBlurhash(imageBuffer: Buffer): Promise<string> {
  const { default: sharp } = await import('sharp')
  const { encode } = await import('blurhash')

  const { data, info } = await sharp(imageBuffer)
    .resize(32, 32, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  return encode(new Uint8ClampedArray(data), info.width, info.height, 4, 4)
}
