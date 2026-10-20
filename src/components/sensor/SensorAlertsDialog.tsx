import { isDefinedError } from '@orpc/client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { BellIcon, PlusIcon } from 'lucide-react'
import { useId, useState } from 'react'
import { toast } from 'sonner'
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
  /** Per sensor, the typical gap between merged readings (the "I rad" hint); null without one. */
  typicalGapMinutes: Record<string, number | null> | undefined
  view: SensorAlertsView
  onView: (view: SensorAlertsView) => void
  onClose: () => void
}

// "Larm för <sensor>" (ADR-0028): the viewer's own rules for one sensor, and the form for one of
// them, as two views of one overlay (ADR-0013 URL state: `alertId`). Only the viewer gets these
// emails; every signed-in user may manage their own.
export function SensorAlertsDialog({
  open,
  device,
  rules,
  rulesFailed = false,
  typicalGapMinutes,
  view,
  onView,
  onClose,
}: Props) {
  // Keep the last sensor while the close animation runs (the URL — and so `device` — clears first).
  const [shown, setShown] = useState(device)
  if (device && (device.id !== shown?.id || device.displayName !== shown.displayName)) {
    setShown(device)
  }
  const current = device ?? shown

  const own = current && rules ? rules.filter((r) => r.deviceId === current.id) : undefined
  // An id that isn't one of this sensor's rules (deleted, or another sensor's) is the list.
  const editing = view === 'list' || view === 'new' ? undefined : own?.find((r) => r.id === view)
  const formOpen = view === 'new' || editing !== undefined

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <ResponsiveDialogContent className="sm:max-w-md">
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
            onBack={() => onView('list')}
          />
        ) : (
          <RuleList
            device={current}
            rules={own}
            failed={rulesFailed}
            onOpen={onView}
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
  onOpen,
  onNew,
}: {
  device: SensorAlertsDevice
  rules: readonly SensorAlertRuleDto[] | undefined
  failed: boolean
  onOpen: (id: string) => void
  onNew: () => void
}) {
  if (rules === undefined) {
    return failed ? (
      <p className="text-destructive text-sm">{m.sensors_alert_rules_failed()}</p>
    ) : (
      <p className="flex items-center gap-2 text-muted-foreground text-sm">
        <Spinner />
        {m.sensors_alert_rules_loading()}
      </p>
    )
  }

  const newButton = (
    <Button type="button" onClick={onNew}>
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
      <ul aria-label={m.sensors_alert_list_label()} className="flex flex-col gap-2">
        {rules.map((rule) => (
          <RuleRow key={rule.id} rule={rule} onOpen={() => onOpen(rule.id)} />
        ))}
      </ul>
      <ResponsiveDialogFooter>{newButton}</ResponsiveDialogFooter>
    </>
  )
}

// One rule: the row opens it in the form; the switch beside it (not inside: a button can't hold
// another control) pauses or resumes it.
function RuleRow({ rule, onOpen }: { rule: SensorAlertRuleDto; onOpen: () => void }) {
  const queryClient = useQueryClient()
  const descriptionId = useId()
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

  return (
    <li className="flex items-center gap-3 rounded-lg border pr-3">
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          'min-h-11 flex-1 rounded-l-lg px-3 py-2 text-left text-sm outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50',
          !enabled && 'text-muted-foreground',
        )}
      >
        <span id={descriptionId}>{alertRuleDescription(rule)}</span>
      </button>
      <Switch
        checked={enabled}
        onCheckedChange={(next) => setEnabled.mutate({ id: rule.id, enabled: next })}
        aria-label={m.sensors_alert_enabled_label()}
        aria-describedby={descriptionId}
      />
    </li>
  )
}
