import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ArrowLeftIcon } from 'lucide-react'
import { PageContainer } from '~/components/layout/PageContainer'
import { RecommendationEditor } from '~/components/recommendation/RecommendationEditor'
import { Button } from '~/components/ui/button'
import { useGoBack } from '~/hooks/useGoBack'
import { orpc } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

export const Route = createFileRoute('/_authenticated/recommendations/new')({
  head: () => ({ meta: seo({ title: m.meta_recommendation_new_title() }) }),
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureQueryData(orpc.tag.list.queryOptions()),
  component: NewRecommendationPage,
})

function NewRecommendationPage() {
  const navigate = useNavigate()
  const goBack = useGoBack('/recommendations')

  return (
    <PageContainer width="prose">
      <Button variant="ghost" size="sm" className="-ml-2 self-start" onClick={goBack}>
        <ArrowLeftIcon />
        {m.common_back()}
      </Button>
      <header className="flex flex-col gap-2">
        <h1 className="font-bold text-2xl tracking-tight text-balance md:text-3xl">
          {m.recommendation_new_title()}
        </h1>
        <p className="text-muted-foreground text-sm">{m.recommendation_new_description()}</p>
      </header>
      <RecommendationEditor
        mode="create"
        onDone={(placeId) =>
          placeId ? navigate({ to: '/recommendations', search: { place: placeId } }) : goBack()
        }
      />
    </PageContainer>
  )
}
