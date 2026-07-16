/**
 * Shared image-upload constants for the public store. Avatar uploads (image.ts)
 * and recommendation photo uploads (recommendation.ts) accept the same set of
 * browser-encodable image types and derive the stored file extension from the
 * content type.
 */
export const UPLOAD_IMAGE_MIME = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/heic',
  'image/heif',
] as const

export const UPLOAD_IMAGE_EXT: Record<(typeof UPLOAD_IMAGE_MIME)[number], string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/heif': 'heif',
}
