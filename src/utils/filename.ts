/**
 * Build a `Content-Disposition` value that forces a download under the given
 * filename and survives non-ASCII characters (Swedish å/ä/ö). RFC 6266/5987:
 * a plain `filename=` ASCII fallback plus a `filename*=UTF-8''` percent-encoded
 * form that conformant browsers prefer.
 */
export function contentDispositionAttachment(filename: string): string {
  // ASCII fallback: replace quotes/backslashes that would break the
  // quoted-string, and collapse anything outside printable ASCII to `_`.
  const asciiFallback = filename.replace(/["\\]/g, '_').replace(/[^\x20-\x7e]/g, '_')
  const encoded = encodeURIComponent(filename)
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`
}
