// A dash that still says why, for screen readers and on hover.
export function Unknown({ label }: { label: string }) {
  return (
    <span title={label}>
      <span aria-hidden="true">—</span>
      <span className="sr-only">{label}</span>
    </span>
  )
}
