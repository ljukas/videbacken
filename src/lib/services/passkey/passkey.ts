import { eq } from 'drizzle-orm'
import { db } from '~/lib/db'
import { passkey } from '~/lib/db/schema'

// Whether the user has at least one registered passkey. Drives the login
// screen's CTA hierarchy via the browser-session cookie's `hasPasskey` hint.
export async function userHasPasskey(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: passkey.id })
    .from(passkey)
    .where(eq(passkey.userId, userId))
    .limit(1)
  return row !== undefined
}
