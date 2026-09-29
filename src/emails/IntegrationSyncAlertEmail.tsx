import { render } from 'react-email'
import type { IntegrationErrorCode, IntegrationSource } from '~/lib/integrationHealth'
import { integrationErrorMessage, integrationSourceName } from '~/lib/integrationHealthMessage'
import { m } from '~/paraglide/messages'
import type { Locale } from '~/paraglide/runtime'
import { BrandEmailLayout } from './BrandEmailLayout'

export interface IntegrationSyncAlertEmailProps {
  source: IntegrationSource
  transition: 'started_failing' | 'recovered'
  // Non-null on `started_failing` (recordOutcome always attaches an error
  // code on failure); null on `recovered` (health is back to `ok`, nothing to
  // explain). See `~/lib/integrationHealth`.
  code: IntegrationErrorCode | null
  // Explicit rather than read from the Paraglide request scope: this email is
  // rendered by the queue worker, outside any request. See ADR-0008/0017's
  // note on `InviteUserEmail.tsx`.
  locale: Locale
}

// The button always points at the app's charging overview — there's no
// per-message deep link (unlike the invite/magic-link emails' one-time
// URLs), so the origin comes straight from BETTER_AUTH_URL rather than a
// prop. See CLAUDE.md's env var table.
const actionUrl = () => `${process.env.BETTER_AUTH_URL}/charging`

export const IntegrationSyncAlertEmail = ({
  source,
  transition,
  code,
  locale,
}: IntegrationSyncAlertEmailProps) => {
  const sourceName = integrationSourceName(source)
  const isFailing = transition === 'started_failing'

  // Heading doubles as the email subject (see `renderIntegrationSyncAlert`
  // below) — e.g. "Synkningen mot Zaptec fungerar inte" / "… fungerar igen".
  // "Synkningen mot {source}" reads for a product name and a domain alike.
  const heading = isFailing
    ? m.email_integration_sync_heading_failing({ source: sourceName }, { locale })
    : m.email_integration_sync_heading_recovered({ source: sourceName }, { locale })

  const intro = isFailing
    ? m.email_integration_sync_body_failing({ source: sourceName }, { locale })
    : m.email_integration_sync_body_recovered({ source: sourceName }, { locale })
  const body =
    isFailing && code ? `${intro} ${integrationErrorMessage(code, { source, locale })}` : intro

  const preview = isFailing
    ? m.email_integration_sync_preview_failing({ source: sourceName }, { locale })
    : m.email_integration_sync_preview_recovered({ source: sourceName }, { locale })

  return (
    <BrandEmailLayout
      locale={locale}
      actionUrl={actionUrl()}
      preview={preview}
      heading={heading}
      body={body}
      buttonLabel={m.email_integration_sync_button({}, { locale })}
      fallbackText={m.email_integration_sync_fallback({}, { locale })}
      footer={m.email_integration_sync_footer({}, { locale })}
    />
  )
}

IntegrationSyncAlertEmail.PreviewProps = {
  source: 'zaptec',
  transition: 'started_failing',
  code: 'auth_failed',
  locale: 'sv',
} satisfies IntegrationSyncAlertEmailProps

export default IntegrationSyncAlertEmail

export async function renderIntegrationSyncAlert(props: IntegrationSyncAlertEmailProps) {
  const sourceName = integrationSourceName(props.source)
  const subject =
    props.transition === 'started_failing'
      ? m.email_integration_sync_heading_failing({ source: sourceName }, { locale: props.locale })
      : m.email_integration_sync_heading_recovered({ source: sourceName }, { locale: props.locale })
  const [html, text] = await Promise.all([
    render(<IntegrationSyncAlertEmail {...props} />),
    render(<IntegrationSyncAlertEmail {...props} />, { plainText: true }),
  ])
  return { subject, html, text }
}
