import { Badge } from '~/components/ui/badge'
import { type TagSlug, tagLabels } from './tagLabels'

export function TagChip({ slug }: { slug: TagSlug }) {
  return <Badge variant="secondary">{tagLabels[slug]()}</Badge>
}
