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
