import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { expect, test } from 'vitest'
import { transcodeHeicToJpeg } from './heicTranscode'

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
