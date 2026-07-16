import { useState } from 'react'
import { expect, test, vi } from 'vitest'
import { m } from '~/paraglide/messages'
import { makeTestQueryClient, renderWithProviders } from '~test/browser/render'
import { PhotoUploader } from './PhotoUploader'
import type { FormPhoto } from './recommendationFormTypes'

// Hold the upload flow open so the freshly-created slot stays in `status:'uploading'`
// — we're asserting the *instant* tile + progress UI, not the upload's completion.
// (mintImageUpload's real network call never fires; runUploadFlow is stubbed.)
const neverResolves = new Promise<void>(() => {})
vi.mock('~/lib/effects/storage/clientUpload', () => ({
  runUploadFlow: vi.fn(() => neverResolves),
}))

// PhotoUploader is controlled (parent owns `value`/`onChange`); this harness wires
// the round-trip so the tile actually renders once `addFiles` calls `onChange`.
function Harness() {
  const [value, setValue] = useState<FormPhoto[]>([])
  return <PhotoUploader value={value} onChange={setValue} />
}

// A genuine in-memory PNG `File` — non-HEIC, so the preview comes from the raw
// bytes (object URL) and the tile renders without any client-side decode.
function pngFile(): File {
  // 1x1 transparent PNG.
  const base64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  return new File([bytes], 'photo.png', { type: 'image/png' })
}

// An empty-`type` `.heic` File — exactly what iOS sometimes hands the picker.
// The extension-aware HEIC check must coerce its contentType to `image/heic` so
// it passes validation rather than being rejected as "unsupported format".
function emptyTypeHeicFile(): File {
  const bytes = Uint8Array.from([0, 0, 0, 0])
  return new File([bytes], 'photo.heic', { type: '' })
}

test('adding a non-HEIC file renders an instant tile with a preview and upload progress', async () => {
  const { screen } = await renderWithProviders(<Harness />, { queryClient: makeTestQueryClient() })

  const input = screen.container.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error('file input not found')

  // The input gets its `accept` from the platform-aware `imageAccept` helper. In
  // this (non-iOS) Chromium env it must default to the HEIC-inclusive list so
  // HEIC stays selectable and the server worker transcodes (iOS omits heic and
  // relies on the native Photos-picker conversion instead).
  expect(input.getAttribute('accept') ?? '').toContain('image/heic')

  // Drive the hidden <input type=file> the way a real selection does: stage the
  // File via a DataTransfer, then dispatch the `change` event the component reads
  // (`e.target.files`). Runs in real Chromium, so the DOM file APIs are present.
  const dt = new DataTransfer()
  dt.items.add(pngFile())
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))

  // The tile appears immediately — no client transcode gap — showing the cover
  // badge (it's the first tile) and the upload-in-flight overlay (the Spinner's
  // role=status). These retry-able assertions wait for the tile to mount.
  await expect.element(screen.getByText(m.recommendation_photo_cover())).toBeVisible()
  await expect.element(screen.getByRole('status', { name: 'Loading' })).toBeVisible()

  // The preview renders from the raw bytes — an object URL, not the placeholder.
  const img = screen.container.querySelector('img')
  expect(img).not.toBeNull()
  expect(img?.getAttribute('src') ?? '').toMatch(/^blob:/)
})

test('adding an empty-type .heic file is accepted (not rejected as unsupported)', async () => {
  const { screen } = await renderWithProviders(<Harness />, { queryClient: makeTestQueryClient() })

  const input = screen.container.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error('file input not found')

  const dt = new DataTransfer()
  dt.items.add(emptyTypeHeicFile())
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))

  // The tile mounts — proving the empty-type `.heic` passed validation (its
  // contentType was coerced to `image/heic`) and is uploading, rather than being
  // dropped with the "unsupported format" toast. The cover badge + upload overlay
  // only render for a slot that made it into `value`.
  await expect.element(screen.getByText(m.recommendation_photo_cover())).toBeVisible()
  await expect.element(screen.getByRole('status', { name: 'Loading' })).toBeVisible()

  // Native iPhone HEICs carry no extractable EXIF JPEG, so the preview is the
  // neutral placeholder (empty previewUrl) — there's no <img>, confirming the
  // HEIC branch ran rather than the raw-bytes object-URL path.
  expect(screen.container.querySelector('img')).toBeNull()
})
