// Dependency-free, client-safe. Parses a decimal typed the way people type
// them here: "5,331" (Swedish comma), "35.60", "−3" (Unicode minus), with
// optional spaces as thousands separators. Returns null for anything else —
// never NaN — so a form can say "not a number" instead of saving garbage.
export function parseDecimal(input: string): number | null {
  const normalized = input
    .trim()
    .replace(/[\s  ]/g, '')
    .replace(/^[−‒–]/, '-')
    .replace(',', '.')
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null
  return Number(normalized)
}
