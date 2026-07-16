import { logger } from '~/lib/logger/server'
import type { EmailEffects } from '../email'

export const devLog: EmailEffects = {
  async sendMagicLink({ to, url, locale }) {
    // In prod this adapter only runs on email misconfiguration; the URL is a
    // live sign-in link, so never write it to Runtime Logs (ADR-0008).
    const safeUrl = process.env.NODE_ENV === 'production' ? '[redacted]' : url
    logger.info('magic-link (devLog)', { to, url: safeUrl, locale })
  },
  async sendUserInvited({ to, inviteUrl, locale }) {
    // Like the magic link, the invite URL grants sign-in (verify + auto-sign-in),
    // so never write it to Runtime Logs in prod (ADR-0008).
    const safeUrl = process.env.NODE_ENV === 'production' ? '[redacted]' : inviteUrl
    logger.info('invite (devLog)', { to, inviteUrl: safeUrl, locale })
  },
}
