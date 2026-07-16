import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Navigate, useNavigate } from '@tanstack/react-router'
import { ArrowLeftIcon } from 'lucide-react'
import { PageContainer } from '~/components/layout/PageContainer'
import { RecommendationEditor } from '~/components/recommendation/RecommendationEditor'
import type { FormPhoto } from '~/components/recommendation/recommendationFormTypes'
import { Button } from '~/components/ui/button'
import { useGoBack } from '~/hooks/useGoBack'
import { orpc } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

export const Route = createFileRoute('/_authenticated/recommendations/$id/edit')({
  head: () => ({ meta: seo({ title: m.meta_recommendation_edit_title() }) }),
  loader: async ({ context: { queryClient }, params }) => {
    await Promise.all([
      queryClient.ensureQueryData(
        orpc.recommendation.get.queryOptions({ input: { id: params.id } }),
      ),
      queryClient.ensureQueryData(orpc.tag.list.queryOptions()),
      queryClient.ensureQueryData(orpc.user.me.queryOptions()),
    ])
  },
  component: EditRecommendationPage,
})

function EditRecommendationPage() {
  const { id } = Route.useParams()
  const navigate = useNavigate()
  const goBack = useGoBack('/recommendations')

  const { data: place } = useSuspenseQuery(orpc.recommendation.get.queryOptions({ input: { id } }))
  const { data: me } = useSuspenseQuery(orpc.user.me.queryOptions())

  // Author-or-admin only; everyone else bounces back to the place on the map.
  const canEdit = me.role === 'admin' || place.authorId === me.id
  if (!canEdit) return <Navigate to="/recommendations" search={{ place: id }} replace />

  const initialPhotos: FormPhoto[] = place.photos.map((p) => ({
    kind: 'existing',
    photoId: p.id,
    url: p.url,
    blurhash: p.blurhash,
  }))

  return (
    <PageContainer width="prose">
      <Button variant="ghost" size="sm" className="-ml-2 self-start" onClick={goBack}>
        <ArrowLeftIcon />
        {m.common_back()}
      </Button>
      <header className="flex flex-col gap-2">
        <h1 className="font-bold text-2xl tracking-tight text-balance md:text-3xl">
          {m.recommendation_edit_title()}
        </h1>
        <p className="text-muted-foreground text-sm">{m.recommendation_edit_description()}</p>
      </header>
      <RecommendationEditor
        mode="edit"
        recommendationId={id}
        initial={{
          title: place.title,
          description: place.description ?? '',
          lat: place.lat,
          lng: place.lng,
          tagIds: place.tagIds,
          photos: initialPhotos,
        }}
        onDone={() => navigate({ to: '/recommendations', search: { place: id } })}
      />
    </PageContainer>
  )
}
