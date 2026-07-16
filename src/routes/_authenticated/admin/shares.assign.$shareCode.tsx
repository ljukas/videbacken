import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Navigate, redirect } from '@tanstack/react-router'
import { ArrowLeftIcon } from 'lucide-react'
import { useMemo } from 'react'
import { PageContainer } from '~/components/layout/PageContainer'
import { ShareAssignForm } from '~/components/share/ShareAssignForm'
import { Button } from '~/components/ui/button'
import { useGoBack } from '~/hooks/useGoBack'
import { orpc } from '~/lib/orpc/client'
import { SHARE_CODES, type ShareCode } from '~/lib/shares/codes'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

function isShareCode(code: string): code is ShareCode {
  return (SHARE_CODES as ReadonlyArray<string>).includes(code)
}

export const Route = createFileRoute('/_authenticated/admin/shares/assign/$shareCode')({
  head: () => ({
    meta: seo({ title: m.meta_shares_title(), description: m.meta_shares_description() }),
  }),
  loader: async ({ context: { queryClient }, params }) => {
    // Guard an invalid code before fetching; listAll always returns all 10 shares.
    if (!isShareCode(params.shareCode)) throw redirect({ to: '/admin/shares' })
    await Promise.all([
      queryClient.ensureQueryData(orpc.share.listAll.queryOptions()),
      queryClient.ensureQueryData(orpc.user.list.queryOptions({ input: { filter: 'active' } })),
    ])
  },
  component: AssignSharePage,
})

function AssignSharePage() {
  const { shareCode } = Route.useParams()
  const goBack = useGoBack('/admin/shares')

  const { data: shares } = useSuspenseQuery(orpc.share.listAll.queryOptions())
  const { data: users } = useSuspenseQuery(
    orpc.user.list.queryOptions({ input: { filter: 'active' } }),
  )

  const userOptions = useMemo(
    () => users.map((u) => ({ id: u.id, name: u.name, image: u.image })),
    [users],
  )

  // `shareCode` is validated in the loader; narrow it for the typed lookup.
  const code = shareCode as ShareCode
  const share = shares.find((s) => s.shareCode === code)
  if (!share) return <Navigate to="/admin/shares" replace />

  return (
    <PageContainer width="prose">
      <Button variant="ghost" size="sm" className="-ml-2 self-start" onClick={goBack}>
        <ArrowLeftIcon />
        {m.common_back()}
      </Button>

      <header className="flex flex-col gap-2">
        <h1 className="font-bold text-2xl tracking-tight text-balance md:text-3xl">
          {m.share_assign_title({ code })}
        </h1>
        <p className="text-muted-foreground text-sm">{m.share_assign_description()}</p>
      </header>

      <div className="max-w-md">
        <ShareAssignForm share={share} users={userOptions} onDone={goBack} />
      </div>
    </PageContainer>
  )
}
