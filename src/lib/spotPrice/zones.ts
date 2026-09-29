// Dependency-free, client-safe. The Nord Pool bidding zones a spot price row can
// belong to. Only SE3 is fetched today (the household's zone); the zone is still
// stored per row so another zone is an addition, not a migration of existing data.
export const PRICE_ZONES = ['SE3'] as const
export type PriceZone = (typeof PRICE_ZONES)[number]

export const SPOT_ZONE: PriceZone = 'SE3'
