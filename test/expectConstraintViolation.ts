import { expect } from 'vitest'

// drizzle wraps the driver error: its `.message` is "Failed query: ...", and the
// violated constraint name lives on the node-postgres cause (`constraint` /
// message). Assert against that so the test pins the *specific* constraint.
export async function expectConstraintViolation(promise: Promise<unknown>, constraint: string) {
  let error: unknown = null
  try {
    await promise
  } catch (e) {
    error = e
  }
  expect(error, 'expected the insert to be rejected').not.toBeNull()
  const cause = (error as { cause?: unknown }).cause ?? error
  const detail =
    (cause as { constraint?: string }).constraint ??
    (cause as { message?: string }).message ??
    String(error)
  expect(detail).toContain(constraint)
}
