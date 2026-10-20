import { isDefinedError } from '@orpc/client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { BellIcon, PlusIcon } from 'lucide-react'
import { type RefObject, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { RetryAlert } from '~/components/layout/LoadErrorAlert'
import { Button } from '~/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '~/components/ui/empty'
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '~/components/ui/responsive-dialog'
import { Spinner } from '~/components/ui/spinner'
import { Switch } from '~/components/ui/switch'
import { orpc } from '~/lib/orpc/client'
import { sensorAlertErrorMessage } from '~/lib/orpc/sensorAlertErrorMessage'
import type { SensorAlertRuleDto } from '~/lib/sensor/alerts'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { alertRuleDescription } from './alertRuleCopy'
import { SensorAlertRuleForm } from './SensorAlertRuleForm'

export type SensorAlertsDevice = { id: string; displayName: string }

/** The URL's `alertId`: absent is the list, `'new'` an empty form, else a rule's id. */
export type SensorAlertsView = 'list' | 'new' | (string & {})

type Props = {
  open: boolean
  device: SensorAlertsDevice | undefined
  /** The viewer's rules (every sensor's); undefined until they load. */
  rules: readonly SensorAlertRuleDto[] | undefined
  /** The rules failed to load: say so instead of the empty state. */
  rulesFailed?: boolean
  /** Refetch the rules after a failed load. */
  onRetryRules?: () => void
  /** The rules are refetching (the retry's spinner). */
  retryingRules?: boolean
  /** Per sensor, the typical gap between merged readings (the "I rad" hint); null without one. */
  typicalGapMinutes: Record<string, number | null> | undefined
  view: SensorAlertsView
  /**
   * Switch views. List → form is a new history entry; `replace` marks the way back to the list
   * (after Tillbaka, a save or a delete), which must not leave the form behind in the history.
   */
  onView: (view: SensorAlertsView, options?: { replace: true }) => void
  onClose: () => void
}

/** What takes focus when the list comes back: the edited rule's row, or "Nytt larm". */
type ListFocus = { ruleId: string } | 'new'

// "Larm för <sensor>" (ADR-0028): the viewer's own rules for one sensor, and the form for one of
// them, as two views of one overlay (ADR-0013 URL state: `alertId`). Only the viewer gets these
// emails; every signed-in user may manage their own.
export function SensorAlertsDialog({
  open,
  device,
  rules,
  rulesFailed = false,
  onRetryRules,
  retryingRules = false,
  typicalGapMinutes,
  view,
  onView,
  onClose,
}: Props) {
  // Keep the last sensor and view while the close animation runs (the URL — and so `device` and
  // `view` — clears first): closing from the form shouldn't flash the list on the way out.
  const [shown, setShown] = useState(device)
  if (device && (device.id !== shown?.id || device.displayName !== shown.displayName)) {
    setShown(device)
  }
  const current = device ?? shown
  const [shownView, setShownView] = useState(view)
  if (open && view !== shownView) setShownView(view)
  const currentView = open ? view : shownView

  const own = current && rules ? rules.filter((r) => r.deviceId === current.id) : undefined
  const ruleId = currentView === 'list' || currentView === 'new' ? undefined : currentView
  const editing = ruleId === undefined ? undefined : own?.find((r) => r.id === ruleId)
  // A rule id that isn't one of this sensor's loaded rules (deleted elsewhere, or another
  // sensor's): the list, after a toast.
  const vanished = open && ruleId !== undefined && own !== undefined && editing === undefined
  const formOpen = currentView === 'new' || editing !== undefined

  // Toast once per vanished id, not on every render until the URL catches up.
  const toasted = useRef<string | null>(null)
  // Back to the list, replacing the form's history entry; `focus` is what the list focuses.
  const listFocus = useRef<ListFocus | null>(null)
  function backToList(focus: ListFocus) {
    listFocus.current = focus
    // Leaving on purpose: the rule dropping out of the list on the way (a delete) is no news.
    toasted.current = ruleId ?? null
    onView('list', { replace: true })
  }

  useEffect(() => {
    if (!vanished || toasted.current === ruleId) return
    toasted.current = ruleId
    toast.error(m.sensors_alert_error_rule_not_found())
    listFocus.current = 'new'
    onView('list', { replace: true })
  }, [vanished, ruleId, onView])

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <ResponsiveDialogContent
        className="sm:max-w-md"
        // Esc in the form steps back to the list, like Tillbaka; in the list it closes.
        onEscapeKeyDown={(e) => {
          if (!formOpen) return
          e.preventDefault()
          backToList(editing ? { ruleId: editing.id } : 'new')
        }}
      >
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {m.sensors_alert_dialog_title({ name: current?.displayName ?? '' })}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {m.sensors_alert_dialog_description()}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        {current === undefined ? null : formOpen ? (
          // key re-inits the form when another rule (or "new") opens.
          <SensorAlertRuleForm
            key={editing?.id ?? 'new'}
            device={current}
            rule={editing}
            gapMinutes={typicalGapMinutes?.[current.id] ?? null}
            onBack={(result) =>
              backToList(editing && result !== 'deleted' ? { ruleId: editing.id } : 'new')
            }
          />
        ) : (
          <RuleList
            device={current}
            rules={own}
            failed={rulesFailed}
            onRetry={onRetryRules}
            retrying={retryingRules}
            focus={listFocus}
            onOpen={(id) => onView(id)}
            onNew={() => onView('new')}
          />
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

function RuleList({
  device,
  rules,
  failed,
  onRetry,
  retrying,
  focus,
  onOpen,
  onNew,
}: {
  device: SensorAlertsDevice
  rules: readonly SensorAlertRuleDto[] | undefined
  failed: boolean
  onRetry: (() => void) | undefined
  retrying: boolean
  /** Set by the way back from the form: focused once the list is up, then cleared. */
  focus: RefObject<ListFocus | null>
  onOpen: (id: string) => void
  onNew: () => void
}) {
  const listRef = useRef<HTMLUListElement>(null)
  const newRef = useRef<HTMLButtonElement>(null)
  // Coming back from the form: the edited rule's row (if it is still listed), else "Nytt larm" —
  // never <body>, where the unmounted form would leave it.
  useEffect(() => {
    const target = focus.current
    if (target === null || rules === undefined) return
    focus.current = null
    const row =
      target === 'new'
        ? null
        : listRef.current?.querySelector<HTMLElement>(`[data-rule-id="${target.ruleId}"]`)
    ;(row ?? newRef.current)?.focus()
  }, [focus, rules])

  if (rules === undefined) {
    return failed ? (
      <RetryAlert
        title={m.sensors_alert_rules_failed()}
        onRetry={() => onRetry?.()}
        pending={retrying}
      />
    ) : (
      <p className="flex items-center gap-2 text-muted-foreground text-sm">
        {/* The text says it: the spinner's own "Loading" status would say it twice. */}
        <Spinner aria-hidden />
        {m.sensors_alert_rules_loading()}
      </p>
    )
  }

  const newButton = (
    <Button ref={newRef} type="button" onClick={onNew}>
      <PlusIcon />
      {m.sensors_alert_new()}
    </Button>
  )

  if (rules.length === 0) {
    return (
      <Empty className="rounded-lg border py-6">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BellIcon />
          </EmptyMedia>
          <EmptyTitle>{m.sensors_alert_empty_title()}</EmptyTitle>
          <EmptyDescription>
            {m.sensors_alert_empty_description({ name: device.displayName })}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>{newButton}</EmptyContent>
      </Empty>
    )
  }

  return (
    <>
      <ul ref={listRef} aria-label={m.sensors_alert_list_label()} className="flex flex-col gap-2">
        {rules.map((rule) => (
          <RuleRow key={rule.id} rule={rule} onOpen={() => onOpen(rule.id)} />
        ))}
      </ul>
      <ResponsiveDialogFooter>{newButton}</ResponsiveDialogFooter>
    </>
  )
}

// One rule: the row opens it in the form; the switch beside it (not inside: a button can't hold
// another control) pauses or resumes it, named by the rule so a screen reader tells them apart.
function RuleRow({ rule, onOpen }: { rule: SensorAlertRuleDto; onOpen: () => void }) {
  const queryClient = useQueryClient()
  const setEnabled = useMutation(
    orpc.sensor.alerts.setEnabled.mutationOptions({
      onError: (err) =>
        toast.error(
          isDefinedError(err) ? sensorAlertErrorMessage(err.code) : m.sensors_alert_save_error(),
        ),
      // Awaited, so the switch holds its new position until the list has it.
      onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.sensor.alerts.key() }),
    }),
  )
  const enabled = setEnabled.isPending ? setEnabled.variables.enabled : rule.enabled
  const description = alertRuleDescription(rule)

  return (
    <li className="flex items-center gap-3 rounded-lg border pr-3">
      <button
        type="button"
        data-rule-id={rule.id}
        onClick={onOpen}
        className={cn(
          'min-h-11 flex-1 rounded-l-lg px-3 py-2 text-left text-sm outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50',
          !enabled && 'text-muted-foreground',
        )}
      >
        {description}
      </button>
      <Switch
        checked={enabled}
        onCheckedChange={(next) => setEnabled.mutate({ id: rule.id, enabled: next })}
        aria-label={m.sensors_alert_enabled_named({ description })}
      />
    </li>
  )
}
