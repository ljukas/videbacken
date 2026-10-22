import { render } from 'react-email'
import type { QueuePayloadMap } from '~/lib/effects/queue/queue'
import { dateFnsLocaleFor } from '~/lib/i18n/format'
import type { SensorAlertDirection, ValueAlertKind } from '~/lib/sensor/alerts'
import { formatAlertDayTime, formatAlertDuration } from '~/lib/sensor/alertTime'
import { m } from '~/paraglide/messages'
import type { Locale } from '~/paraglide/runtime'
import { BrandEmailLayout } from './BrandEmailLayout'

export type SensorAlertEmailProps = QueuePayloadMap['email_sensor_alert']

type ValueProps = Extract<SensorAlertEmailProps, { kind: ValueAlertKind }>
type SilenceProps = Extract<SensorAlertEmailProps, { kind: 'silence' }>

// The button points at Klimat (BrandEmailLayout also takes the logo's origin from it).
const actionUrl = () => `${process.env.BETTER_AUTH_URL}/sensors`

const intlLocale = (locale: Locale) => (locale === 'sv' ? 'sv-SE' : 'en-GB')

const unit = (kind: ValueAlertKind) => (kind === 'temperature' ? ' °C' : ' %')

// `signDisplay: 'negative'`: a value that rounds to zero ("-0.04") is "0,0", never "−0,0".

/** "5 °C", "80 %": the limit in the recipient's number format, at most one decimal. */
function limitText(p: ValueProps): string {
  const n = new Intl.NumberFormat(intlLocale(p.locale), {
    maximumFractionDigits: 1,
    signDisplay: 'negative',
  })
  return `${n.format(p.threshold)}${unit(p.kind)}`
}

/**
 * The latest reading: temperature with exactly one decimal, humidity with at most one (a rule
 * over 80 % firing on 80.4 must not read "80 %"), battery whole.
 */
function valueText(p: ValueProps): string {
  const digits =
    p.kind === 'temperature'
      ? { minimumFractionDigits: 1, maximumFractionDigits: 1 }
      : p.kind === 'humidity'
        ? { maximumFractionDigits: 1 }
        : { maximumFractionDigits: 0 }
  const n = new Intl.NumberFormat(intlLocale(p.locale), { ...digits, signDisplay: 'negative' })
  return `${n.format(p.value)}${unit(p.kind)}`
}

const time = (iso: string, locale: Locale) =>
  formatAlertDayTime(new Date(iso), dateFnsLocaleFor(locale))

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
function parts(p: ValueProps) {
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

/** One line: any whitespace run in it (a CR/LF in a sensor's name too) is one space. */
function valueSubject(p: ValueProps): string {
  const { name, measure, dir, back, limit, value } = parts(p)
  const { locale } = p
  const text =
    p.transition === 'fired'
      ? m.email_sensor_alert_subject_fired({ name, measure, dir, limit }, { locale })
      : p.kind === 'battery'
        ? m.email_sensor_alert_subject_recovered_battery({ name, value }, { locale })
        : m.email_sensor_alert_subject_recovered({ name, measure, back, limit }, { locale })
  return text.replace(/\s+/g, ' ')
}

function valueFacts(p: ValueProps): { label: string; value: string }[] {
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

const silenceDuration = (p: SilenceProps) =>
  formatAlertDuration(new Date(p.endedAt ?? p.since).getTime() - new Date(p.since).getTime())

/** One line, like `valueSubject`. */
function silenceSubject(p: SilenceProps): string {
  const { sensorName: name, silenceHours: hours, locale } = p
  const text =
    p.transition === 'fired'
      ? m.email_sensor_alert_silence_subject_fired({ name, hours }, { locale })
      : m.email_sensor_alert_silence_subject_recovered({ name }, { locale })
  return text.replace(/\s+/g, ' ')
}

function silenceFacts(p: SilenceProps): { label: string; value: string }[] {
  const { locale, silenceHours: hours } = p
  if (p.transition === 'fired') {
    return [
      { label: m.email_sensor_alert_fact_latest({}, { locale }), value: time(p.since, locale) },
      {
        label: m.email_sensor_alert_fact_limit({}, { locale }),
        value: m.email_sensor_alert_silence_fact_limit_value({ hours }, { locale }),
      },
    ]
  }
  return [
    {
      label: m.email_sensor_alert_silence_fact_period({}, { locale }),
      value: m.email_sensor_alert_fact_period_value(
        {
          since: time(p.since, locale),
          endedAt: time(p.endedAt ?? p.since, locale),
          duration: silenceDuration(p),
        },
        { locale },
      ),
    },
  ]
}

function subject(p: SensorAlertEmailProps): string {
  return p.kind === 'silence' ? silenceSubject(p) : valueSubject(p)
}

function SilenceAlertEmail(props: SilenceProps) {
  const { locale, sensorName: name, silenceHours: hours } = props
  const fired = props.transition === 'fired'
  const sentence = fired
    ? m.email_sensor_alert_silence_body_fired(
        { name, lastAt: time(props.since, locale), hours },
        { locale },
      )
    : m.email_sensor_alert_silence_body_recovered(
        { name, duration: silenceDuration(props) },
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
      facts={silenceFacts(props)}
      note={fired ? m.email_sensor_alert_silence_note({ name }, { locale }) : undefined}
      buttonLabel={m.email_sensor_alert_button({}, { locale })}
      fallbackText={m.email_sensor_alert_fallback({}, { locale })}
      footer={m.email_sensor_alert_footer({ name }, { locale })}
    />
  )
}

export const SensorAlertEmail = (props: SensorAlertEmailProps) => {
  if (props.kind === 'silence') return <SilenceAlertEmail {...props} />
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
      facts={valueFacts(props)}
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
