import { expect, test } from 'vitest'
import { healthPoll } from './healthPoll'

type H = { running: boolean }
const q = (data?: Record<string, H>) => ({ state: { data } })
const idle = { zaptec: { running: false }, elpris: { running: false } }

test('polls every 5 s while this tab has a sync pending', () => {
  expect(healthPoll(true)(q(idle))).toBe(5_000)
})
test('polls every 5 s while the server says any source is running', () => {
  expect(healthPoll(false)(q({ ...idle, emaldo: { running: true } }))).toBe(5_000)
})
test('polls every minute otherwise', () => {
  expect(healthPoll(false)(q(idle))).toBe(60_000)
})
test('polls every minute with no data yet', () => {
  expect(healthPoll(false)(q())).toBe(60_000)
})
test('given the sources a page shows, ignores a run on any other source', () => {
  const emaldoRunning = q({ ...idle, emaldo: { running: true } })
  expect(healthPoll(false, ['zaptec', 'elpris'])(emaldoRunning)).toBe(60_000)
  expect(healthPoll(false, ['zaptec', 'emaldo'])(emaldoRunning)).toBe(5_000)
})
