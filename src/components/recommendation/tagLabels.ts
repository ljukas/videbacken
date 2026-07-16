import { m } from '~/paraglide/messages'

// The fixed, curated tag vocabulary seeded by drizzle/0016_seed_system_tags.sql.
// `tagLabels` is the single source of truth: it maps each slug -> localized label,
// and TagSlug / TAG_SLUGS derive from its keys. Order here is irrelevant — display
// order comes from tag.sortOrder. The slugs must stay in sync with the seed; that
// contract is enforced at runtime by tagLabels.test.ts.
export const tagLabels = {
  restaurant: m.tag_restaurant,
  anchorage: m.tag_anchorage,
  pier: m.tag_pier,
  cove: m.tag_cove,
  beach: m.tag_beach,
  marina: m.tag_marina,
  bar: m.tag_bar,
  snorkeling: m.tag_snorkeling,
  provisioning: m.tag_provisioning,
  viewpoint: m.tag_viewpoint,
} satisfies Record<string, () => string>

export type TagSlug = keyof typeof tagLabels
export const TAG_SLUGS = Object.keys(tagLabels) as TagSlug[]

export function isTagSlug(slug: string): slug is TagSlug {
  return slug in tagLabels
}
