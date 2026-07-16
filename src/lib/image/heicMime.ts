// Single source of truth for "is this a HEIC/HEIF image?" across the codebase.
// iOS shoots HEIC; the upload path transcodes it (client-side first, then a
// server-side `heic_transcode` worker as the backstop). The MIME set and the
// extension test live here so the transcode worker, upload guards, and client
// pickers (tasks 7/9/10/12/15) never re-declare the literal and drift apart.

/** Canonical HEIC/HEIF MIME types. */
export const HEIC_MIME = new Set(['image/heic', 'image/heif'])

/**
 * True when `file` is a HEIC/HEIF image — by MIME type, or by a `.heic`/`.heif`
 * extension when the browser reports an empty/odd type (common for iOS files).
 */
export function isHeicFile(file: File): boolean {
  return HEIC_MIME.has(file.type.toLowerCase()) || /\.hei[cf]$/i.test(file.name)
}

// `accept` for the photo-style image pickers (recommendations + avatars).
//
// On iOS we OMIT heic/heif: the Photos picker then transcodes HEIC→JPEG itself,
// so the file arrives as a directly-displayable JPEG (instant native preview, no
// server `heic_transcode` round-trip, EXIF GPS preserved) — and omitting heic
// also dodges the Safari 17+ bug where listing `image/heic` makes Safari convert
// files the WRONG way (even PNG→HEIC).
//
// Everywhere else we KEEP heic/heif so HEIC stays selectable in desktop/Android
// file dialogs; those uploads go raw and the server worker transcodes them, as
// today. (Document uploads are unaffected — they have their own picker and
// preserve the original HEIC.)
/** Raster-only — for iOS, where the Photos picker converts HEIC→JPEG. */
export const IMAGE_ACCEPT_IOS = 'image/jpeg,image/png,image/webp,image/avif'
/** Includes HEIC — keeps it selectable on desktop/Android (raw → server worker). */
export const IMAGE_ACCEPT_DEFAULT =
  'image/jpeg,image/png,image/webp,image/avif,image/heic,image/heif,.heic,.heif'

/** Picks the photo-input `accept` for the platform (see {@link useIsIOS}). */
export function imageAccept(isIOS: boolean): string {
  return isIOS ? IMAGE_ACCEPT_IOS : IMAGE_ACCEPT_DEFAULT
}
