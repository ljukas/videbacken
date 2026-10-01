import { ORPCError } from '@orpc/client'
import type { EvChargingDomainErrorCode } from '~/lib/services/evCharging'

// Client-safe (type-only import from the service): the typed code the session
// read fails with for an unknown or uncounted id. Typed so a rename breaks here.
const SESSION_NOT_FOUND = 'EV_SESSION_NOT_FOUND' satisfies EvChargingDomainErrorCode

// Whether a failed session read means "no such session" (→ the not-found page),
// as opposed to a transient failure. A caught error is untyped, hence not
// `isDefinedError`, which would narrow it to `never`.
export function isSessionNotFound(err: unknown): boolean {
  return err instanceof ORPCError && err.code === SESSION_NOT_FOUND
}
