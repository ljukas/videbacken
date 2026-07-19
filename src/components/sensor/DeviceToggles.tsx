import { Toggle } from '~/components/ui/toggle'
import { m } from '~/paraglide/messages'

export type ToggleableDevice = { id: string; displayName: string; color: string }

// The interactive color key: a chip per device (its stable color swatch + name)
// that toggles the device's lines in both charts. `pressed` = visible.
export function DeviceToggles({
  devices,
  hidden,
  onToggle,
}: {
  devices: ToggleableDevice[]
  hidden: Set<string>
  onToggle: (id: string) => void
}) {
  return (
    // A fieldset (+ sr-only legend) is the semantic grouping element; the legend
    // names the control group for assistive tech without visual clutter.
    <fieldset className="flex flex-wrap gap-2 border-0 p-0">
      <legend className="sr-only">{m.sensors_devices_label()}</legend>
      {devices.map((d) => {
        const visible = !hidden.has(d.id)
        return (
          <Toggle
            key={d.id}
            pressed={visible}
            onPressedChange={() => onToggle(d.id)}
            variant="outline"
            size="sm"
            aria-label={d.displayName}
            aria-pressed={visible}
          >
            <span
              aria-hidden
              className="mr-2 inline-block size-2.5 shrink-0 rounded-full"
              // A visible chip shows its color; a hidden one dims the swatch.
              style={{ backgroundColor: d.color, opacity: visible ? 1 : 0.35 }}
            />
            {d.displayName}
          </Toggle>
        )
      })}
    </fieldset>
  )
}
