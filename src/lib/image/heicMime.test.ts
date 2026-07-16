import { expect, test } from 'vitest'
import {
  HEIC_MIME,
  IMAGE_ACCEPT_DEFAULT,
  IMAGE_ACCEPT_IOS,
  imageAccept,
  isHeicFile,
} from './heicMime'

test('HEIC_MIME is the canonical HEIC/HEIF mime set', () => {
  expect(HEIC_MIME.has('image/heic')).toBe(true)
  expect(HEIC_MIME.has('image/heif')).toBe(true)
  expect(HEIC_MIME.has('image/jpeg')).toBe(false)
})

test('isHeicFile: true for a HEIC mime type', () => {
  expect(isHeicFile(new File([], 'photo.bin', { type: 'image/heic' }))).toBe(true)
})

test('isHeicFile: true for a .heif extension (no/odd mime type)', () => {
  expect(isHeicFile(new File([], 'IMG_0001.HEIF', { type: '' }))).toBe(true)
})

test('isHeicFile: false for a JPEG', () => {
  expect(isHeicFile(new File([], 'photo.jpg', { type: 'image/jpeg' }))).toBe(false)
})

test('imageAccept: iOS variant omits HEIC so the Photos picker converts to JPEG', () => {
  expect(imageAccept(true)).toBe(IMAGE_ACCEPT_IOS)
  expect(imageAccept(true)).not.toMatch(/heic|heif/i)
})

test('imageAccept: non-iOS keeps HEIC selectable (raw upload → server worker)', () => {
  expect(imageAccept(false)).toBe(IMAGE_ACCEPT_DEFAULT)
  expect(imageAccept(false)).toContain('image/heic')
})
