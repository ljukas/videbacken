import { tz } from '@date-fns/tz'
import { format } from 'date-fns'
import { render } from 'react-email'
import { dateFnsLocaleFor } from '~/lib/i18n/format'
import type { CredentialReminderDays, ExpiringCredentialSource } from '~/lib/integrationHealth'
import { STOCKHOLM_TIME_ZONE } from '~/lib/time/stockholm'
import { m } from '~/paraglide/messages'
import type { Locale } from '~/paraglide/runtime'
import { BrandEmailLayout } from './BrandEmailLayout'

export interface CredentialExpiryEmailProps {
  // Only Škoda has an expiring credential today; the copy (MyŠkoda, SKODA_API_KEY)
  // assumes it — a second source needs its own strings.
  source: ExpiringCredentialSource
  expiresAt: string // ISO
  days: CredentialReminderDays
  // Explicit: rendered by the queue worker, outside any request (ADR-0008).
  locale: Locale
}

// The button points at the charging settings page (the Škoda source's tile;
// BrandEmailLayout also takes the logo's origin from it).
const actionUrl = () => `${process.env.BETTER_AUTH_URL}/charging/settings`

/** "15 januari 2027" / "15 January 2027", the Stockholm calendar date. */
function expiryDate(iso: string, locale: Locale): string {
  return format(new Date(iso), 'd MMMM yyyy', {
    locale: dateFnsLocaleFor(locale),
    in: tz(STOCKHOLM_TIME_ZONE),
  })
}

function heading({ expiresAt, days, locale }: CredentialExpiryEmailProps): string {
  const date = expiryDate(expiresAt, locale)
  return days === 7
    ? m.email_credential_expiry_heading_final({ date }, { locale })
    : m.email_credential_expiry_heading({ date }, { locale })
}

export const CredentialExpiryEmail = (props: CredentialExpiryEmailProps) => {
  const { expiresAt, locale } = props
  const date = expiryDate(expiresAt, locale)
  return (
    <BrandEmailLayout
      locale={locale}
      actionUrl={actionUrl()}
      preview={m.email_credential_expiry_preview({ date }, { locale })}
      heading={heading(props)}
      body={m.email_credential_expiry_body({ date }, { locale })}
      buttonLabel={m.email_credential_expiry_button({}, { locale })}
      fallbackText={m.email_credential_expiry_fallback({}, { locale })}
      footer={m.email_credential_expiry_footer({}, { locale })}
    />
  )
}

CredentialExpiryEmail.PreviewProps = {
  source: 'skoda',
  expiresAt: '2027-01-15T12:00:00.500Z',
  days: 30,
  locale: 'sv',
} satisfies CredentialExpiryEmailProps

export default CredentialExpiryEmail

export async function renderCredentialExpiry(props: CredentialExpiryEmailProps) {
  const [html, text] = await Promise.all([
    render(<CredentialExpiryEmail {...props} />),
    render(<CredentialExpiryEmail {...props} />, { plainText: true }),
  ])
  return { subject: heading(props), html, text }
}
