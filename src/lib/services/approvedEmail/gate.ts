import { isApproved } from './approvedEmail'

// Single source of truth for "may this email sign in, and with what role?".
// Consumed by both auth entry points: the magic-link `sendMagicLink` gate (deny
// before a link is ever sent) and the Better Auth `databaseHooks.user.create.before`
// hook (deny before an account row is created — covers Google OAuth first sign-in
// too). Returns the role recorded on the approved_email row so first sign-in
// stamps the right role on the new user.
export async function resolveSignInDecision(
  email: string,
): Promise<{ allowed: boolean; role: 'user' | 'admin' }> {
  const match = await isApproved(email)
  return match ? { allowed: true, role: match.role } : { allowed: false, role: 'user' }
}
