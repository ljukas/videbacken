import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { extractEmbeddedJpegThumbnail, readGpsFromFile, readImageMetaFromFile } from './exif'

// Real iPhone HEIC committed in Task 3: has GPS, and (verified) NO EXIF-embedded
// JPEG thumbnail — iPhone HEICs store their preview as an HEVC `thmb` item, not
// as an extractable EXIF JPEG, so `exifreader`'s `tags.Thumbnail` is absent and
// `thumbnail` is correctly `null`. The spec (design §"No embedded thumbnail →
// neutral placeholder") treats null as a supported outcome; components fall back
// to a placeholder. Real coordinates read from the fixture once via `exifreader`.
const fixture = fileURLToPath(new URL('../../../test/fixtures/geotagged.heic', import.meta.url))

function heicFile(): File {
  const buf = readFileSync(fixture)
  // `File` is a Node global in this runtime (verified: typeof File === 'function').
  return new File([buf], 'geotagged.heic', { type: 'image/heic' })
}

test('readImageMetaFromFile extracts GPS from the HEIC fixture', async () => {
  const { gps } = await readImageMetaFromFile(heicFile())

  expect(gps).not.toBeNull()
  expect(Number.isFinite(gps?.lat)).toBe(true)
  expect(Number.isFinite(gps?.lng)).toBe(true)
  expect(Math.abs(gps?.lat ?? Number.NaN)).toBeLessThanOrEqual(90)
  expect(Math.abs(gps?.lng ?? Number.NaN)).toBeLessThanOrEqual(180)
  expect(gps?.lat).toBeCloseTo(38.6286, 3)
  expect(gps?.lng).toBeCloseTo(20.5989, 3)
})

test('readImageMetaFromFile returns thumbnail null when the HEIC has no embedded EXIF thumbnail', async () => {
  // This fixture has no EXIF-embedded JPEG thumbnail (verified: no `tags.Thumbnail`,
  // zero JPEG SOI markers in the file). The function must surface that as `null`.
  const { thumbnail } = await readImageMetaFromFile(heicFile())

  expect(thumbnail).toBeNull()
})

test('extractEmbeddedJpegThumbnail wraps embedded JPEG bytes as an image/jpeg Blob', () => {
  // Unit-level proof of the thumbnail-extraction branch the fixture can't exercise:
  // when `tags.Thumbnail.image` is present (ArrayBuffer of a JPEG), it becomes a
  // non-empty image/jpeg Blob; absent → null.
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).buffer

  const blob = extractEmbeddedJpegThumbnail({ Thumbnail: { image: bytes } })
  expect(blob).toBeInstanceOf(Blob)
  expect(blob?.type).toBe('image/jpeg')
  expect(blob?.size).toBeGreaterThan(0)

  expect(extractEmbeddedJpegThumbnail({})).toBeNull()
})

test('readGpsFromFile returns the same gps as readImageMetaFromFile (wrapper parity)', async () => {
  const file = heicFile()
  const viaWrapper = await readGpsFromFile(file)
  const { gps: viaMeta } = await readImageMetaFromFile(heicFile())

  expect(viaWrapper).toEqual(viaMeta)
})
