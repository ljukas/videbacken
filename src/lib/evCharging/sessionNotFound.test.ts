import { createORPCErrorFromJson, ORPCError } from '@orpc/client'
import { expect, test } from 'vitest'
import { isSessionNotFound } from './sessionNotFound'

test('the typed not-found error is a not-found', () => {
  expect(
    isSessionNotFound(new ORPCError('EV_SESSION_NOT_FOUND', { status: 404, defined: true })),
  ).toBe(true)
})

test('the same error after a JSON round-trip (as the browser client receives it) is too', () => {
  const json = new ORPCError('EV_SESSION_NOT_FOUND', { status: 404, defined: true }).toJSON()
  expect(isSessionNotFound(createORPCErrorFromJson(JSON.parse(JSON.stringify(json))))).toBe(true)
})

test('another ORPC error code is not', () => {
  expect(isSessionNotFound(new ORPCError('BAD_REQUEST'))).toBe(false)
  expect(isSessionNotFound(new ORPCError('INTERNAL_SERVER_ERROR'))).toBe(false)
})

test('a plain Error or a non-error is not', () => {
  expect(isSessionNotFound(new Error('EV_SESSION_NOT_FOUND'))).toBe(false)
  expect(isSessionNotFound('EV_SESSION_NOT_FOUND')).toBe(false)
  expect(isSessionNotFound(undefined)).toBe(false)
})
