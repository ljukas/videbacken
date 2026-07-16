import { expect, test } from 'vitest'
import { queue } from './queue'

test('publish resolves without throwing', async () => {
  await expect(
    queue.publish('blurhash', { fileId: 'abc', kind: 'avatar', userId: 'user-1' }),
  ).resolves.toBeUndefined()
})

test('repeated publishes do not throw', async () => {
  await queue.publish('blurhash', { fileId: 'one', kind: 'avatar', userId: 'user-1' })
  await expect(
    queue.publish('blurhash', { fileId: 'two', kind: 'avatar', userId: 'user-1' }),
  ).resolves.toBeUndefined()
})
