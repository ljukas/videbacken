import { render } from 'react-email'
import { m } from '~/paraglide/messages'
import type { Locale } from '~/paraglide/runtime'
import { BrandEmailLayout } from './BrandEmailLayout'

export interface GridTariffAvailableEmailProps {
  // The grid company as the Eltariff catalogue names it; null when the
  // catalogue entry has no name (the coverage still counts).
  companyName: string | null
  // Explicit rather than read from the Paraglide request scope: this email is
  // rendered by the queue worker, outside any request (ADR-0008).
  locale: Locale
}

// The button points at the charging overview, where the tariff periods live.
// Same origin rule as `IntegrationSyncAlertEmail`: BETTER_AUTH_URL, no prop.
const actionUrl = () => `${process.env.BETTER_AUTH_URL}/charging`

export const GridTariffAvailableEmail = ({
  companyName,
  locale,
}: GridTariffAvailableEmailProps) => {
  const company = companyName ?? m.email_grid_tariff_company_unknown({}, { locale })
  return (
    <BrandEmailLayout
      locale={locale}
      actionUrl={actionUrl()}
      preview={m.email_grid_tariff_preview({ company }, { locale })}
      heading={m.email_grid_tariff_heading({}, { locale })}
      body={m.email_grid_tariff_body({ company }, { locale })}
      buttonLabel={m.email_grid_tariff_button({}, { locale })}
      fallbackText={m.email_grid_tariff_fallback({}, { locale })}
      footer={m.email_grid_tariff_footer({}, { locale })}
    />
  )
}

GridTariffAvailableEmail.PreviewProps = {
  companyName: 'Vattenfall Eldistribution AB',
  locale: 'sv',
} satisfies GridTariffAvailableEmailProps

export default GridTariffAvailableEmail

export async function renderGridTariffAvailable(props: GridTariffAvailableEmailProps) {
  // The subject is the fixed heading: the company name (third-party catalogue
  // text) only ever appears in the body, where React escapes it.
  const subject = m.email_grid_tariff_heading({}, { locale: props.locale })
  const [html, text] = await Promise.all([
    render(<GridTariffAvailableEmail {...props} />),
    render(<GridTariffAvailableEmail {...props} />, { plainText: true }),
  ])
  return { subject, html, text }
}
