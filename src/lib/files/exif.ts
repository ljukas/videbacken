import ExifReader from 'exifreader'

// Wrap an `exifreader` expanded-tags `Thumbnail.image` (the EXIF-embedded JPEG
// bytes) as an `image/jpeg` Blob, or `null` when the image has no embedded
// thumbnail. Pure + synchronous so the Blob-wrapping branch is unit testable
// without a fixture that happens to carry a thumbnail (iPhone HEICs usually
// don't — see `readImageMetaFromFile`). exifreader types `Thumbnail.image` as
// `ArrayBuffer | SharedArrayBuffer | Buffer`; in the browser it is always a
// plain `ArrayBuffer`. `SharedArrayBuffer` is not a structural `BlobPart` (and a
// `Uint8Array<ArrayBufferLike>` carries that union in its backing buffer), so we
// assert `BlobPart` at the single construction site — the runtime value is
// always a real `ArrayBuffer`/typed array the Blob constructor accepts.
export function extractEmbeddedJpegThumbnail(tags: {
  Thumbnail?: { image?: ArrayBuffer | SharedArrayBuffer | Uint8Array }
}): Blob | null {
  const image = tags.Thumbnail?.image
  return image ? new Blob([image as BlobPart], { type: 'image/jpeg' }) : null
}

// Read GPS coordinates AND the EXIF-embedded JPEG thumbnail from an image File,
// in the browser, in a single `exifreader` pass — done BEFORE any HEIC->JPEG
// transcode (the transcode strips metadata — ADR-0012 §4). We use `exifreader`
// rather than `exifr`: exifr rejects iPhone HEICs whose `ftyp` box exceeds 50
// bytes (i.e. a major brand + several compatible brands — every modern iPhone
// photo), throwing "Unknown file format", so HEIC GPS never reached the map (see
// ADR-0012 2026-06-29 amendment). `{ expanded: true }` yields
// `gps.Latitude`/`gps.Longitude` as sign-applied decimals (N/E positive, S/W
// negative) and surfaces an EXIF thumbnail (if any) under `Thumbnail.image`.
//
// `gps` is null on: no GPS block, unparseable metadata, or non-finite/out-of-range
// values — the caller then falls back to manual placement. `thumbnail` is null
// when the HEIC carries no EXIF-embedded JPEG (common: iPhone HEICs store their
// preview as an HEVC `thmb` item, not an extractable JPEG); the caller then shows
// a neutral placeholder during the server transcode's pending window. Components
// turn the Blob into a preview via `URL.createObjectURL` (kept out of here so the
// function stays node-testable).
export async function readImageMetaFromFile(
  file: File,
): Promise<{ gps: { lat: number; lng: number } | null; thumbnail: Blob | null }> {
  try {
    const tags = ExifReader.load(await file.arrayBuffer(), { expanded: true })
    const lat = tags.gps?.Latitude
    const lng = tags.gps?.Longitude
    const gps =
      typeof lat === 'number' &&
      typeof lng === 'number' &&
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lng) <= 180
        ? { lat, lng }
        : null
    return { gps, thumbnail: extractEmbeddedJpegThumbnail(tags) }
  } catch {
    return { gps: null, thumbnail: null }
  }
}

// Thin wrapper preserving the original public API + behavior (the recommendation
// PhotoUploader's only need today). Tasks 12/13 switch callers to
// `readImageMetaFromFile` for the embedded-thumbnail preview.
export async function readGpsFromFile(file: File): Promise<{ lat: number; lng: number } | null> {
  return (await readImageMetaFromFile(file)).gps
}
