import { expect, test } from 'vitest'
import { realtimeEventSchema } from './types'

test('realtimeEventSchema accepts recommendation.changed with ids', () => {
  expect(realtimeEventSchema.parse({ kind: 'recommendation.changed', ids: ['abc'] })).toEqual({
    kind: 'recommendation.changed',
    ids: ['abc'],
  })
})

test('realtimeEventSchema accepts recommendation.changed without ids', () => {
  expect(realtimeEventSchema.parse({ kind: 'recommendation.changed' })).toEqual({
    kind: 'recommendation.changed',
  })
})
