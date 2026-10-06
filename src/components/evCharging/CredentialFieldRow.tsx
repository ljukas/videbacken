import { AlertTriangleIcon, CircleAlertIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Label } from '~/components/ui/label'
import {
  CREDENTIAL_ENV_VARS,
  type CredentialFieldName,
  type CredentialSource,
  credentialFieldKind,
} from '~/lib/integrationCredentials'
import { credentialFieldLabel } from '~/lib/integrationCredentialsMessage'
import { m } from '~/paraglide/messages'
import { formatDate } from './format'

/** Where a field's value comes from; `unknown` while the status hasn't loaded. */
export type CredentialFieldState = 'stored' | 'env' | 'missing' | 'unreadable' | 'unknown'

/** A field with a value: its input stays closed until replaced, and saving keeps the current value. */
export const hasCredentialValue = (state: CredentialFieldState) =>
  state === 'stored' || state === 'env'

/**
 * Whether a field may stay closed (and be closed again): one with a value, and
 * the home position even when missing — its map loads only when asked for (3c-2).
 */
export const isClosableField = (
  source: CredentialSource,
  field: string,
  state: CredentialFieldState,
) =>
  hasCredentialValue(state) ||
  (state === 'missing' && credentialFieldKind(source, field) === 'position')

// DOM ids namespaced per source: bare field names (`password`, `user`) would
// collide with other inputs on the page and invite password-manager matching.
export const credentialInputId = (source: CredentialSource, field: string) =>
  `credential-${source}-${field}`
export const credentialLabelId = (source: CredentialSource, field: string) =>
  `${credentialInputId(source, field)}-label`
export const credentialSuspectId = (source: CredentialSource, field: string) =>
  `${credentialInputId(source, field)}-suspect`
export const credentialRevealId = (source: CredentialSource, field: string) =>
  `${credentialInputId(source, field)}-reveal`
/** The state badge: announced first with the open input, so tabbing into it says where its value stands. */
export const credentialBadgeId = (source: CredentialSource, field: string) =>
  `${credentialInputId(source, field)}-badge`

type Props = {
  source: CredentialSource
  field: CredentialFieldName
  state: CredentialFieldState
  /** Save date for 'stored'. */
  savedAt: Date | null
  open: boolean
  /** Closed rows only: reveal the input (the caller moves focus to it). */
  onOpen: () => void
  /** Open rows that may close again (stored/env): hide and clear the input. */
  onClose?: () => void
  suspect: boolean
  /** Disabled reveal button (encryption key missing), described by this id. */
  disabledBy?: string
  /** A save is running: the reveal and close actions wait for it. */
  busy?: boolean
  /** The bound input (form.AppField → field.TextField labelled by the row header), rendered only when open. */
  children: ReactNode
}

// One credential field in the dialog (ADR-0026). The header says where the
// value comes from (a badge: real text, never colour alone); a field with a
// value stays closed behind a summary and a reveal button, so an empty input
// never reads as "nothing saved".
export function CredentialFieldRow({
  source,
  field,
  state,
  savedAt,
  open,
  onOpen,
  onClose,
  suspect,
  disabledBy,
  busy = false,
  children,
}: Props) {
  const label = credentialFieldLabel(source, field)
  const inputId = credentialInputId(source, field)
  const suspectId = credentialSuspectId(source, field)
  // Named "{action}, {field}": the visible text first (WCAG 2.5.3 label in name).
  const actionLabel = (action: string) =>
    m.charging_credentials_field_action_label({ action, field: label })
  // The home position is picked on a map.
  const onMap = credentialFieldKind(source, field) === 'position'
  const reveal =
    state === 'stored'
      ? onMap
        ? m.charging_credentials_change_on_map()
        : m.charging_credentials_replace()
      : onMap
        ? m.charging_credentials_choose_on_map()
        : m.charging_credentials_set_in_app()
  const summaryId = `${inputId}-summary`
  // The reveal button carries the row's context for keyboard and screen-reader
  // users who tab straight to it: why it is disabled, the last sync's verdict,
  // and the summary.
  const describedBy = [disabledBy, suspect ? suspectId : null, summaryId].filter(Boolean).join(' ')
  const envVar = (CREDENTIAL_ENV_VARS[source] as Record<string, string>)[field]

  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1">
        <Label id={credentialLabelId(source, field)} htmlFor={open ? inputId : undefined}>
          {label}
        </Label>
        <StateBadge id={credentialBadgeId(source, field)} state={state} />
        {open && onClose ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            // 44 px on touch without growing the header: the extra height overlaps the gap.
            className="ml-auto h-7 px-1 pointer-coarse:-my-2 pointer-coarse:h-11"
            aria-label={actionLabel(m.charging_credentials_close_field())}
            disabled={busy}
            onClick={onClose}
          >
            {m.charging_credentials_close_field()}
          </Button>
        ) : null}
      </div>
      {suspect ? (
        <p id={suspectId} className="flex items-center gap-1.5 text-destructive text-sm">
          <CircleAlertIcon aria-hidden className="size-4 shrink-0" />
          {m.charging_credentials_field_suspect()}
        </p>
      ) : null}
      {open ? (
        children
      ) : (
        <div className="flex items-center justify-between gap-3">
          <p id={summaryId} className="min-w-0 text-muted-foreground text-sm">
            {state === 'stored' && savedAt ? (
              m.charging_credentials_origin_stored({ date: formatDate(savedAt) })
            ) : state === 'env' ? (
              <>
                {m.charging_credentials_using_env()}{' '}
                <code className="break-words rounded bg-muted px-1 py-0.5 font-mono text-foreground text-xs">
                  {envVar}
                </code>
              </>
            ) : state === 'missing' && onMap ? (
              m.charging_credentials_home_missing_summary()
            ) : null}
          </p>
          <Button
            id={credentialRevealId(source, field)}
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0 pointer-coarse:h-11"
            aria-label={actionLabel(reveal)}
            aria-describedby={describedBy}
            disabled={disabledBy !== undefined || busy}
            onClick={onOpen}
          >
            {reveal}
          </Button>
        </div>
      )}
    </div>
  )
}

function StateBadge({ id, state }: { id: string; state: CredentialFieldState }) {
  switch (state) {
    case 'stored':
      return (
        <Badge id={id} variant="outline" className="text-muted-foreground">
          {m.charging_credentials_badge_stored()}
        </Badge>
      )
    case 'env':
      return (
        <Badge id={id} variant="outline" className="text-muted-foreground">
          {m.charging_credentials_badge_env()}
        </Badge>
      )
    case 'missing':
      return (
        <Badge id={id} variant="outline" className="border-dashed text-muted-foreground">
          {m.charging_credentials_badge_missing()}
        </Badge>
      )
    case 'unreadable':
      // Amber, not red: red is reserved for errors on a field.
      return (
        <Badge
          id={id}
          variant="outline"
          className="border-warning/40 bg-warning/15 text-warning-foreground dark:text-warning"
        >
          <AlertTriangleIcon aria-hidden data-icon="inline-start" />
          {m.charging_credentials_badge_unreadable()}
        </Badge>
      )
    case 'unknown':
      return null // status not loaded: say nothing rather than guess
  }
}
