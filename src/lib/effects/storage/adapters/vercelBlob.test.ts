import { put } from '@vercel/blob'
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client'
import { beforeAll, expect, test, vi } from 'vitest'
import { vercelBlob } from './vercelBlob'

// Keep the real exports (BlobNotFoundError etc.) and only stub the two write
// entrypoints so we can inspect the options the adapter passes. The no-op guard
// tests below short-circuit before reaching these, so they stay unaffected.
vi.mock('@vercel/blob', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vercel/blob')>()),
  put: vi.fn(async () => ({ url: 'https://blob.example/x' })),
}))
vi.mock('@vercel/blob/client', () => ({
  generateClientTokenFromReadWriteToken: vi.fn(async () => 'client-token'),
}))

beforeAll(() => {
  process.env.BLOB_PUBLIC_READ_WRITE_TOKEN ??= 'test-public-token'
})

// VERCEL_ENV is unset in tests → the current env prefix is 'dev/', so a `prod/`
// pathname is foreign-origin. The store is shared across environments, so the
// adapter must refuse to mutate a foreign byte (it belongs to prod). These
// resolve without a BLOB token because the guard short-circuits before any
// token lookup or network call — proving no prod object is ever touched.

test('delete no-ops on a foreign-origin pathname (no token, no network)', async () => {
  await expect(vercelBlob.delete('private', 'prod/documents/x.pdf')).resolves.toBeUndefined()
  await expect(vercelBlob.delete('public', 'prod/avatars/u/a.png')).resolves.toBeUndefined()
})

test('copy no-ops when either endpoint is foreign-origin', async () => {
  await expect(
    vercelBlob.copy(
      'private',
      'prod/documents/old.pdf',
      'prod/documents/new.pdf',
      'application/pdf',
    ),
  ).resolves.toBeUndefined()
})

test('mintUploadToken passes a one-year cacheControlMaxAge for public uploads', async () => {
  await vercelBlob.mintUploadToken({
    access: 'public',
    pathname: 'avatars/u/abc.png',
    contentType: 'image/png',
    maxBytes: 5_000_000,
  })
  expect(generateClientTokenFromReadWriteToken).toHaveBeenCalledWith(
    expect.objectContaining({ cacheControlMaxAge: 31_536_000 }),
  )
})

test('put passes a one-year cacheControlMaxAge for public objects', async () => {
  await vercelBlob.put('public', 'thumbnails/x.webp', Buffer.from('a'), 'image/webp')
  expect(put).toHaveBeenCalledWith(
    expect.any(String),
    expect.anything(),
    expect.objectContaining({ cacheControlMaxAge: 31_536_000 }),
  )
})
