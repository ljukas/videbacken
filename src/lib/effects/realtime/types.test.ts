import { expect, test } from 'vitest'
import { realtimeEventSchema } from './types'

test('realtimeEventSchema accepts user.changed with ids', () => {
  expect(realtimeEventSchema.parse({ kind: 'user.changed', ids: ['abc'] })).toEqual({
    kind: 'user.changed',
    ids: ['abc'],
  })
})

test('realtimeEventSchema accepts user.changed without ids', () => {
  expect(realtimeEventSchema.parse({ kind: 'user.changed' })).toEqual({
    kind: 'user.changed',
  })
})

test('realtimeEventSchema accepts presence.changed', () => {
  expect(realtimeEventSchema.parse({ kind: 'presence.changed' })).toEqual({
    kind: 'presence.changed',
  })
})
