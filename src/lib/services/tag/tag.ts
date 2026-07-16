import { asc } from 'drizzle-orm'
import { db } from '~/lib/db'
import { tag } from '~/lib/db/schema'

export function listTags() {
  return db
    .select({ id: tag.id, slug: tag.slug, sortOrder: tag.sortOrder })
    .from(tag)
    .orderBy(asc(tag.sortOrder))
}
