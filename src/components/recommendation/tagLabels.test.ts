import { expect, test } from 'vitest'
import * as tagService from '~/lib/services/tag'
import { setupDatabase } from '~test/setup'
import { isTagSlug, TAG_SLUGS, tagLabels } from './tagLabels'

setupDatabase()

test('every seeded tag slug has a label entry', async () => {
  const tags = await tagService.listTags()
  expect(tags.length).toBeGreaterThan(0)
  for (const t of tags) {
    expect(isTagSlug(t.slug), `seeded slug "${t.slug}" missing from tagLabels`).toBe(true)
  }
})

test('the registry declares no slugs that are not seeded', async () => {
  const seeded = new Set((await tagService.listTags()).map((t) => t.slug))
  for (const slug of TAG_SLUGS) {
    expect(seeded.has(slug), `tagLabels slug "${slug}" is not seeded`).toBe(true)
  }
})

test('every label is callable and returns a non-empty string', () => {
  for (const slug of TAG_SLUGS) {
    expect(tagLabels[slug]()).toBeTruthy()
  }
})
