import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { passkey, user } from '~/lib/db/schema'
import { setupDatabase } from '~test/setup'
import { userHasPasskey } from './passkey'

setupDatabase()

async function insertMember(email: string) {
  const [row] = await db
    .insert(user)
    .values({ name: email, email, role: 'user' })
    .returning({ id: user.id })
  return row.id
}

test('userHasPasskey returns false for a user without passkeys', async () => {
  const aliceId = await insertMember('alice@test.oceanview.local')
  expect(await userHasPasskey(aliceId)).toBe(false)
})

test('userHasPasskey returns true once the user has a passkey', async () => {
  const aliceId = await insertMember('alice@test.oceanview.local')
  await db.insert(passkey).values({
    userId: aliceId,
    publicKey: 'test-public-key',
    credentialID: 'test-credential-id',
    counter: 0,
    deviceType: 'singleDevice',
    backedUp: false,
  })
  expect(await userHasPasskey(aliceId)).toBe(true)
})

test('userHasPasskey ignores passkeys belonging to other users', async () => {
  const aliceId = await insertMember('alice@test.oceanview.local')
  const bobId = await insertMember('bob@test.oceanview.local')
  await db.insert(passkey).values({
    userId: bobId,
    publicKey: 'test-public-key',
    credentialID: 'test-credential-id',
    counter: 0,
    deviceType: 'singleDevice',
    backedUp: false,
  })
  expect(await userHasPasskey(aliceId)).toBe(false)
})
