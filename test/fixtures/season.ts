import type { SeasonEra } from '~/lib/services/season/logic'

// The production anchor-era seed (ADR-0019; drizzle/0020_seed_season_era_anchor.sql):
// the single {fromYear, startWeek, startShare} row every Disponeringslista
// schedule is computed from. Shared by the season logic unit tests and the
// DisponeringslistaTable component test so a convention change touches one
// typed literal, not two independent copies.
export const ANCHOR_ERA: SeasonEra = { fromYear: 2024, startWeek: 21, startShare: 'J' }
