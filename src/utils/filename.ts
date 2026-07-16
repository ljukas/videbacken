/**
 * Filename helpers shared by the document service, the rename UI, and the
 * download route. The single rule for what counts as an "extension" lives
 * here so the byte's stored `document.name` (base) and `document.extension`
 * stay consistent with how a name is displayed and how a download is named.
 */

export type SplitFilename = { base: string; extension: string | null }

/**
 * Split a filename into its base and extension. The extension is the segment
 * after the last `.`, but only when that dot has at least one character before
 * it (so dotfiles like `.gitignore` keep their leading dot as part of the
 * base) and at least one character after it. Case is preserved — downloads are
 * case-sensitive; the search haystack lowercases separately.
 *
 *   'manual.pdf'      → { base: 'manual',      extension: 'pdf' }
 *   'archive.tar.gz'  → { base: 'archive.tar', extension: 'gz'  }
 *   'README'          → { base: 'README',      extension: null  }
 *   '.gitignore'      → { base: '.gitignore',  extension: null  }
 *   'photo.'          → { base: 'photo.',      extension: null  }
 */
export function splitExtension(filename: string): SplitFilename {
  const dot = filename.lastIndexOf('.')
  if (dot <= 0 || dot === filename.length - 1) {
    return { base: filename, extension: null }
  }
  return { base: filename.slice(0, dot), extension: filename.slice(dot + 1) }
}

/** Reassemble the display filename from a stored base + extension. */
export function joinFilename(input: { name: string; extension?: string | null }): string {
  return input.extension ? `${input.name}.${input.extension}` : input.name
}

/**
 * Make a filename safe to use as a storage pathname segment. Transliterates
 * accented Latin letters to ASCII first (NFD decomposes e.g. å/ä→`a`+mark and
 * ö→`o`+mark; stripping the combining marks yields å→a, ä→a, ö→o and the
 * uppercase forms), then collapses any remaining non-`[A-Za-z0-9._-]` run to a
 * single `-`. Capped at 200 chars.
 *
 * The pathname basename is the prod (Vercel Blob) download filename, so this is
 * what a renamed document downloads as in prod — readable ASCII rather than the
 * `-`-riddled output of a plain strip. Dev keeps the exact UTF-8 name via the
 * read-time `Content-Disposition` (see the s3 adapter).
 */
export function safeFilename(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .slice(0, 200)
}

/**
 * Swap the basename (final `/`-segment) of a logical storage pathname, keeping
 * any directory prefix — including the env prefix the Vercel Blob adapter adds
 * (`prod/documents/{uuid}/`). Used to rename a document's stored object in
 * place. A pathname with no slash is treated as a bare basename.
 */
export function replacePathnameBasename(pathname: string, basename: string): string {
  const slash = pathname.lastIndexOf('/')
  return slash === -1 ? basename : `${pathname.slice(0, slash + 1)}${basename}`
}

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
