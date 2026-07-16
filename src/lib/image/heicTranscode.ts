// HEIC/HEIF → JPEG decode for the background transcode worker. `heic-convert`
// wraps libheif (wasm) and runs in Node without a browser/canvas. The client no
// longer transcodes; it uploads raw HEIC and this worker does the conversion.
// sharp can't decode HEIC (the prebuilt libvips omits libheif), so it's only
// used downstream for resizing the decoded JPEG. Dynamic-imported so the wasm
// loads on first job, not at module load.
export async function transcodeHeicToJpeg(input: Buffer): Promise<Buffer> {
  const { default: convert } = await import('heic-convert')
  const out = await convert({ buffer: input, format: 'JPEG', quality: 0.85 })
  return Buffer.from(out)
}

// Max width of the in-editor preview; keeps the base64 payload light (~tens of KB).
const PREVIEW_MAX_WIDTH = 512
const PREVIEW_JPEG_QUALITY = 72

// Decode a HEIC/HEIF to a small, downscaled JPEG for an ephemeral in-editor preview
// (the `image.previewHeic` procedure). Browsers can't render an iPhone HEIC's HEVC
// `thmb`, and PR #61 deliberately dropped the client-side libheif decoder, so the
// editor would otherwise show a bare placeholder until the post-save worker lands.
// Same libheif decode as the worker, then a sharp downscale. Pure transform — the
// caller stores nothing. sharp can't decode HEIC (prebuilt libvips omits libheif),
// so it only resizes the already-decoded JPEG; dynamic-imported like `generateBlurhash`.
export async function transcodeHeicToPreviewJpeg(input: Buffer): Promise<Buffer> {
  const jpeg = await transcodeHeicToJpeg(input)
  const { default: sharp } = await import('sharp')
  return sharp(jpeg)
    .resize({ width: PREVIEW_MAX_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: PREVIEW_JPEG_QUALITY })
    .toBuffer()
}
