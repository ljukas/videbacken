import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { expect, test } from 'vitest'
import { transcodeHeicToJpeg, transcodeHeicToPreviewJpeg } from './heicTranscode'

const fixture = fileURLToPath(new URL('../../../test/fixtures/geotagged.heic', import.meta.url))

test('decodes a HEIC buffer to a valid JPEG', async () => {
  const jpeg = await transcodeHeicToJpeg(readFileSync(fixture))
  const meta = await sharp(jpeg).metadata()
  expect(meta.format).toBe('jpeg')
  expect(meta.width).toBeGreaterThan(0)
})

test('throws on non-HEIC bytes', async () => {
  await expect(transcodeHeicToJpeg(Buffer.from('not an image'))).rejects.toThrow()
})

test('preview transcode returns a downscaled JPEG (width ≤ 512, lighter than full)', async () => {
  const heic = readFileSync(fixture)
  const [preview, full] = await Promise.all([
    transcodeHeicToPreviewJpeg(heic),
    transcodeHeicToJpeg(heic),
  ])
  const meta = await sharp(preview).metadata()
  expect(meta.format).toBe('jpeg')
  expect(meta.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(512)
  // A downscaled preview should be materially lighter than the full-res transcode.
  expect(preview.byteLength).toBeLessThan(full.byteLength)
})

test('preview transcode throws on non-HEIC bytes', async () => {
  await expect(transcodeHeicToPreviewJpeg(Buffer.from('not an image'))).rejects.toThrow()
})
