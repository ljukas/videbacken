import { expect, test } from 'vitest'
import { applyEnvPrefix, isRemoteOriginPathname, storage, stripEnvPrefix } from './storage'

// Tests run with VERCEL_ENV unset → envPrefix() resolves to 'dev/'.
test('applyEnvPrefix prepends the current env prefix to a logical path', () => {
  expect(applyEnvPrefix('documents/x.pdf')).toBe('dev/documents/x.pdf')
  expect(applyEnvPrefix('avatars/user-1/abc.png')).toBe('dev/avatars/user-1/abc.png')
})

test('applyEnvPrefix leaves an already-prefixed pathname untouched (no double-prefix)', () => {
  // The preview "Blob not found" regression: a prod row read from another env
  // must resolve verbatim in the shared store, never become preview/prod/….
  expect(applyEnvPrefix('prod/documents/x.pdf')).toBe('prod/documents/x.pdf')
  expect(applyEnvPrefix('preview/avatars/u/a.png')).toBe('preview/avatars/u/a.png')
  expect(applyEnvPrefix('dev/documents/y.pdf')).toBe('dev/documents/y.pdf')
})

test('applyEnvPrefix and stripEnvPrefix round-trip a logical path', () => {
  expect(stripEnvPrefix(applyEnvPrefix('documents/x.pdf'))).toBe('documents/x.pdf')
})

test('isRemoteOriginPathname flags a foreign-env (prod) prefix, not the current env', () => {
  // current env in tests is 'dev/'.
  expect(isRemoteOriginPathname('prod/documents/x.pdf')).toBe(true)
  expect(isRemoteOriginPathname('preview/avatars/u/a.png')).toBe(true)
  // Own env and unprefixed (dev's s3 uploads) are local, not remote.
  expect(isRemoteOriginPathname('dev/documents/x.pdf')).toBe(false)
  expect(isRemoteOriginPathname('documents/x.pdf')).toBe(false)
})

test('mintUploadToken returns a pathname and a typed upload payload', async () => {
  const result = await storage.mintUploadToken({
    access: 'public',
    pathname: 'avatars/user-1/abc',
    contentType: 'image/jpeg',
    maxBytes: 1_000_000,
  })
  expect(result.pathname).toBe('avatars/user-1/abc')
  expect(result.upload.kind).toBeTypeOf('string')
  if (result.upload.kind === 'vercel-blob-client') {
    expect(result.upload.clientToken).toBeTypeOf('string')
  } else {
    expect(result.upload.url).toBeTypeOf('string')
  }
})

test('mintUploadToken routes private the same way', async () => {
  const result = await storage.mintUploadToken({
    access: 'private',
    pathname: 'documents/manual.pdf',
    contentType: 'application/pdf',
    maxBytes: 25_000_000,
  })
  expect(result.pathname).toBe('documents/manual.pdf')
  expect(result.upload.kind).toBeTypeOf('string')
})

test('head returns a stub HeadResult for any pathname', async () => {
  const result = await storage.head('public', 'avatars/anything')
  expect(result).not.toBeNull()
  expect(result?.url).toContain('avatars/anything')
  expect(typeof result?.contentType).toBe('string')
  expect(typeof result?.size).toBe('number')
})

test('delete resolves without throwing', async () => {
  await expect(storage.delete('public', 'avatars/test')).resolves.toBeUndefined()
  await expect(storage.delete('private', 'documents/test.pdf')).resolves.toBeUndefined()
})

test('copy resolves without throwing (devLog no-op)', async () => {
  await expect(
    storage.copy('private', 'documents/a/old.pdf', 'documents/a/new.pdf', 'application/pdf'),
  ).resolves.toBeUndefined()
})

test('getReadUrl returns a string URL for private', async () => {
  const url = await storage.getReadUrl('private', 'documents/test.pdf', 60)
  expect(typeof url).toBe('string')
  expect(url.length).toBeGreaterThan(0)
})

test('getReadUrl returns a string URL for public', async () => {
  const url = await storage.getReadUrl('public', 'avatars/user-1/abc.png', 60)
  expect(typeof url).toBe('string')
  expect(url.length).toBeGreaterThan(0)
})

test('getReadUrl accepts a downloadFilename without throwing (devLog no-op)', async () => {
  const url = await storage.getReadUrl('private', 'documents/test.pdf', 60, {
    downloadFilename: 'Motormanual.pdf',
  })
  expect(typeof url).toBe('string')
  expect(url.length).toBeGreaterThan(0)
})
