import { expect, test } from 'vitest'
import { generateImageThumbnail, THUMBNAIL_MAX_EDGE } from './thumbnail'

async function makePng(width: number, height: number): Promise<Buffer> {
  const { default: sharp } = await import('sharp')
  return sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 120, b: 200 } },
  })
    .png()
    .toBuffer()
}

// RIFF<4 bytes size>WEBP — the WebP container magic.
function isWebp(buf: Buffer): boolean {
  return (
    buf.length > 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  )
}

test('renders a non-empty WebP', async () => {
  const out = await generateImageThumbnail(await makePng(1200, 800))
  expect(isWebp(out)).toBe(true)
  expect(out.byteLength).toBeGreaterThan(0)
})

test('fits the long edge within THUMBNAIL_MAX_EDGE', async () => {
  const { default: sharp } = await import('sharp')
  const out = await generateImageThumbnail(await makePng(1200, 600))
  const meta = await sharp(out).metadata()
  expect(meta.format).toBe('webp')
  expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(THUMBNAIL_MAX_EDGE)
})

test('does not enlarge images already smaller than the cap', async () => {
  const { default: sharp } = await import('sharp')
  const out = await generateImageThumbnail(await makePng(100, 80))
  const meta = await sharp(out).metadata()
  expect(meta.width).toBe(100)
  expect(meta.height).toBe(80)
})

test('rejects bytes it cannot decode', async () => {
  await expect(generateImageThumbnail(Buffer.from('not an image'))).rejects.toThrow()
})
