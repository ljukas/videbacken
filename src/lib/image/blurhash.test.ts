import sharp from 'sharp'
import { expect, test } from 'vitest'
import { generateBlurhash } from './blurhash'

// Build a deterministic 64x64 horizontal red/blue split as a PNG. Avoids
// committing a binary fixture; sharp is already pulled in by the module
// under test.
async function makeSplitImage(): Promise<Buffer> {
  const width = 64
  const height = 64
  const pixels = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3
      const left = x < width / 2
      pixels[i] = left ? 220 : 30
      pixels[i + 1] = 30
      pixels[i + 2] = left ? 30 : 220
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer()
}

test('generateBlurhash returns a non-empty string for a real PNG buffer', async () => {
  const hash = await generateBlurhash(await makeSplitImage())
  expect(typeof hash).toBe('string')
  expect(hash.length).toBeGreaterThan(6)
})

test('generateBlurhash is deterministic for the same input', async () => {
  const buf = await makeSplitImage()
  const a = await generateBlurhash(buf)
  const b = await generateBlurhash(buf)
  expect(a).toBe(b)
})
