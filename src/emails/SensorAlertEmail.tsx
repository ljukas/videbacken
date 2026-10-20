import { tz } from '@date-fns/tz'
import { format } from 'date-fns'
import { render } from 'react-email'
import { dateFnsLocaleFor } from '~/lib/i18n/format'
import type { SensorAlertDirection, ValueAlertKind } from '~/lib/sensor/alerts'
import { formatAlertDuration } from '~/lib/sensor/alertTime'
import { STOCKHOLM_TIME_ZONE } from '~/lib/time/stockholm'
import { m } from '~/paraglide/messages'
import type { Locale } from '~/paraglide/runtime'
import { BrandEmailLayout } from './BrandEmailLayout'

export interface SensorAlertEmailProps {
  to: string
  // Explicit: rendered by the queue worker, outside any request (ADR-0008).
  locale: Locale
  transition: 'fired' | 'recovered'
  sensorName: string
  kind: ValueAlertKind
  direction: SensorAlertDirection
  threshold: number
  count: number
  value: number
  since: string // ISO
  endedAt: string | null // ISO
}

// The button points at Klimat (BrandEmailLayout also takes the logo's origin from it).
const actionUrl = () => `${process.env.BETTER_AUTH_URL}/sensors`

const intlLocale = (locale: Locale) => (locale === 'sv' ? 'sv-SE' : 'en-GB')

const unit = (kind: ValueAlertKind) => (kind === 'temperature' ? ' °C' : ' %')

/** "5 °C", "80 %": the limit in the recipient's number format, at most one decimal. */
function limitText(p: SensorAlertEmailProps): string {
  const n = new Intl.NumberFormat(intlLocale(p.locale), { maximumFractionDigits: 1 })
  return `${n.format(p.threshold)}${unit(p.kind)}`
}

/** The latest reading: temperature with one decimal, humidity and battery whole. */
function valueText(p: SensorAlertEmailProps): string {
  const digits = p.kind === 'temperature' ? 1 : 0
  const n = new Intl.NumberFormat(intlLocale(p.locale), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
  return `${n.format(p.value)}${unit(p.kind)}`
}

const time = (iso: string, locale: Locale) =>
  format(new Date(iso), 'd MMM HH:mm', {
    locale: dateFnsLocaleFor(locale),
    in: tz(STOCKHOLM_TIME_ZONE),
  })

const measureWord = (kind: ValueAlertKind, locale: Locale): string =>
  kind === 'temperature'
    ? m.email_sensor_alert_measure_temperature({}, { locale })
    : kind === 'humidity'
      ? m.email_sensor_alert_measure_humidity({}, { locale })
      : m.email_sensor_alert_measure_battery({}, { locale })

const dirWord = (direction: SensorAlertDirection, locale: Locale): string =>
  direction === 'below'
    ? m.email_sensor_alert_dir_below({}, { locale })
    : m.email_sensor_alert_dir_above({}, { locale })

const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** Everything the copy interpolates, derived once. */
function parts(p: SensorAlertEmailProps) {
  const { locale, direction } = p
  const measure = measureWord(p.kind, locale)
  return {
    name: p.sensorName,
    measure,
    Measure: upperFirst(measure),
    dir: dirWord(direction, locale),
    back: dirWord(direction === 'below' ? 'above' : 'below', locale),
    limit: limitText(p),
    value: valueText(p),
    count: p.count,
  }
}

function subject(p: SensorAlertEmailProps): string {
  const { name, measure, dir, back, limit, value } = parts(p)
  const { locale } = p
  if (p.transition === 'fired') {
    return m.email_sensor_alert_subject_fired({ name, measure, dir, limit }, { locale })
  }
  return p.kind === 'battery'
    ? m.email_sensor_alert_subject_recovered_battery({ name, value }, { locale })
    : m.email_sensor_alert_subject_recovered({ name, measure, back, limit }, { locale })
}

function facts(p: SensorAlertEmailProps): { label: string; value: string }[] {
  const { locale, direction } = p
  const { dir, limit, value } = parts(p)
  const latest = {
    label: m.email_sensor_alert_fact_latest({}, { locale }),
    value,
  }
  if (p.transition === 'fired') {
    return [
      latest,
      {
        label: m.email_sensor_alert_fact_limit({}, { locale }),
        value: m.email_sensor_alert_fact_limit_value({ dir, limit }, { locale }),
      },
      {
        label:
          direction === 'below'
            ? m.email_sensor_alert_fact_since_below({}, { locale })
            : m.email_sensor_alert_fact_since_above({}, { locale }),
        value: time(p.since, locale),
      },
    ]
  }
  const endedAt = p.endedAt ?? p.since
  const duration = formatAlertDuration(new Date(endedAt).getTime() - new Date(p.since).getTime())
  return [
    latest,
    {
      label:
        direction === 'below'
          ? m.email_sensor_alert_fact_period_below({}, { locale })
          : m.email_sensor_alert_fact_period_above({}, { locale }),
      value: m.email_sensor_alert_fact_period_value(
        { since: time(p.since, locale), endedAt: time(endedAt, locale), duration },
        { locale },
      ),
    },
  ]
}

export const SensorAlertEmail = (props: SensorAlertEmailProps) => {
  const { locale, transition } = props
  const { name, measure, Measure, dir, back, limit, count } = parts(props)
  const fired = transition === 'fired'
  const sentence = fired
    ? m.email_sensor_alert_body_fired({ measure: Measure, name, dir, limit, count }, { locale })
    : m.email_sensor_alert_body_recovered(
        { measure: Measure, name, back, limit, count },
        { locale },
      )
  return (
    <BrandEmailLayout
      locale={locale}
      actionUrl={actionUrl()}
      preview={sentence}
      heading={
        fired
          ? m.email_sensor_alert_heading_fired({ name }, { locale })
          : m.email_sensor_alert_heading_recovered({ name }, { locale })
      }
      body={sentence}
      facts={facts(props)}
      note={fired ? m.email_sensor_alert_note({ measure, back, limit }, { locale }) : undefined}
      buttonLabel={m.email_sensor_alert_button({}, { locale })}
      fallbackText={m.email_sensor_alert_fallback({}, { locale })}
      footer={m.email_sensor_alert_footer({ name }, { locale })}
    />
  )
}

SensorAlertEmail.PreviewProps = {
  to: 'lukas@example.com',
  locale: 'sv',
  transition: 'fired',
  sensorName: 'Förråd',
  kind: 'temperature',
  direction: 'below',
  threshold: 5,
  count: 2,
  value: 4.8,
  since: '2027-01-15T12:00:00Z',
  endedAt: null,
} satisfies SensorAlertEmailProps

export default SensorAlertEmail

export async function renderSensorAlert(props: SensorAlertEmailProps) {
  const [html, text] = await Promise.all([
    render(<SensorAlertEmail {...props} />),
    render(<SensorAlertEmail {...props} />, { plainText: true }),
  ])
  return { subject: subject(props), html, text }
}
