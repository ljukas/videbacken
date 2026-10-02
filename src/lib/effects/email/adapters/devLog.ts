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
  async sendIntegrationSyncAlert({ to, source, transition, code }) {
    logger.info('integration sync alert (devLog)', { to, source, transition, code })
  },
  async sendGridTariffAvailable({ to, companyName }) {
    logger.info('grid tariff available (devLog)', { to, companyName })
  },
  async sendCredentialExpiry({ to, source, expiresAt, days }) {
    logger.info('credential expiry (devLog)', { to, source, expiresAt, days })
  },
}
