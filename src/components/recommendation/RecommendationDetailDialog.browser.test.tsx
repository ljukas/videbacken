import { expect, test } from 'vitest'
import type { RouterOutputs } from '~/lib/orpc/client'
import { orpc } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { makeTestQueryClient, renderWithProviders } from '~test/browser/render'
import { RecommendationDetailDialog } from './RecommendationDetailDialog'

// Exact shapes derived from the router so the seed can't drift from what the
// component reads (type-only imports → erased from the bundle).
type Place = RouterOutputs['recommendation']['get']
type Me = RouterOutputs['user']['me']

const PLACE_ID = '11111111-1111-1111-1111-111111111111'

// A pending photo (transcode still running, url: null) and a failed one
// (transcodeFailedAt set, url: null) — the two placeholder states under test.
const place: Place = {
  id: PLACE_ID,
  title: 'Vlychos',
  description: null,
  lat: 38.7,
  lng: 20.7,
  authorId: 'author-1',
  authorName: 'Bob Sjöman',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  tagIds: [],
  photos: [
    {
      id: 'photo-pending',
      fileId: 'file-pending',
      pathname: 'recommendations/author-1/pending.heic',
      mime: 'image/heic',
      blurhash: null,
      transcodeFailedAt: null,
      sortOrder: 0,
      pending: true,
      failed: false,
      url: null,
    },
    {
      id: 'photo-failed',
      fileId: 'file-failed',
      pathname: 'recommendations/author-1/failed.heic',
      mime: 'image/heic',
      blurhash: null,
      transcodeFailedAt: new Date('2026-01-02T00:00:00Z'),
      sortOrder: 1,
      pending: false,
      failed: true,
      url: null,
    },
  ],
}

// A viewer who is neither the author nor an admin → canManage is false, so the
// dialog renders no `Link` (route hooks the harness can't provide yet).
const fakeMe: Me = {
  id: 'viewer-1',
  name: 'Alice Svensson',
  email: 'alice@example.se',
  emailVerified: true,
  image: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  role: 'user',
  banned: false,
  banReason: null,
  banExpires: null,
  phone: null,
  deletedAt: null,
  imageBlurhash: null,
  lastInvitedAt: null,
  onboardedAt: new Date('2026-01-02T00:00:00Z'),
}

function seededClient() {
  const queryClient = makeTestQueryClient()
  // Never hand-write the keys — let the oRPC helpers build them.
  queryClient.setQueryData(orpc.recommendation.get.queryKey({ input: { id: PLACE_ID } }), place)
  queryClient.setQueryData(orpc.tag.list.queryKey(), [])
  queryClient.setQueryData(orpc.user.me.queryKey(), fakeMe)
  return queryClient
}

test('renders the processing placeholder for a pending photo and the failed one for a failed photo', async () => {
  const { screen } = await renderWithProviders(
    <RecommendationDetailDialog placeId={PLACE_ID} open onOpenChange={() => {}} />,
    { queryClient: seededClient() },
  )

  // The pending photo is photos[0] (the active carousel slide); its "processing"
  // placeholder is visible without advancing the carousel.
  await expect.element(screen.getByText(m.recommendation_photo_processing())).toBeVisible()
  // The failed photo's "couldn't process" copy is present in the (off-screen)
  // carousel slide — assert it's in the DOM rather than visible.
  await expect
    .element(screen.getByText(m.recommendation_photo_processing_failed()))
    .toBeInTheDocument()
})
