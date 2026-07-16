import { m } from '~/paraglide/messages'

// Short month labels indexed 0..11 (Jan..Dec). The season only touches
// positions 4..9 (May..Oct) in practice, but the array keeps the lookup
// branchless. Message FUNCTIONS, called at render so the labels follow the
// active locale (precedent: AppSidebar nav items).
export const MONTH_LABELS = [
  m.season_month_jan,
  m.season_month_feb,
  m.season_month_mar,
  m.season_month_apr,
  m.season_month_may,
  m.season_month_jun,
  m.season_month_jul,
  m.season_month_aug,
  m.season_month_sep,
  m.season_month_oct,
  m.season_month_nov,
  m.season_month_dec,
] as const

// Owned-cell highlight: 2px inset ring drawn inside the cell box so it
// never collides with the table's month-divider `border-r` or the
// year-block's heavy `border-t-2`. `--foreground` is the semantic
// contrast token against both the light share-pastel backgrounds
// (current-year cells) and the card background (other-year cells).
export const OWNED_RING = 'ring-2 ring-inset ring-foreground'
