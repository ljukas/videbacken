import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { PageContainer } from '~/components/layout/PageContainer'
import { AssignmentHistorySheet } from '~/components/share/AssignmentHistorySheet'
import { ShareCard } from '~/components/share/ShareCard'
import { UnassignShareDialog } from '~/components/share/UnassignShareDialog'
import { useUrlDialog } from '~/hooks/useUrlDialog'
import { orpc } from '~/lib/orpc/client'
import { SHARE_CODES } from '~/lib/shares/codes'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

const shareCodeSchema = z.enum(SHARE_CODES)

// `assign` is no longer a dialog — it's the dedicated route
// `/admin/shares/assign/$shareCode` (ADR-0013). Only unassign + history remain overlays.
const sharesSearchSchema = z.object({
  dialog: z.enum(['unassign', 'history']).optional(),
  shareCode: shareCodeSchema.optional(),
})

type SharesSearch = z.infer<typeof sharesSearchSchema>
type SharesDialog = NonNullable<SharesSearch['dialog']>

export const Route = createFileRoute('/_authenticated/admin/shares/')({
  head: () => ({
    meta: seo({
      title: m.meta_shares_title(),
      description: m.meta_shares_description(),
    }),
  }),
  validateSearch: sharesSearchSchema,
  loaderDeps: ({ search }) => ({
    dialog: search.dialog,
    shareCode: search.shareCode,
  }),
  loader: async ({ context: { queryClient }, deps }) => {
    await Promise.all([
      queryClient.ensureQueryData(orpc.share.listAll.queryOptions()),
      ...(deps.dialog === 'history' && deps.shareCode
        ? [
            queryClient.ensureQueryData(
              orpc.share.listHistory.queryOptions({ input: { shareCode: deps.shareCode } }),
            ),
          ]
        : []),
    ])
  },
  component: AdminShares,
})

function AdminShares() {
  const { data: shares } = useSuspenseQuery(orpc.share.listAll.queryOptions())
  const navigate = Route.useNavigate()
  const dialogShareCode = Route.useSearch({ select: (s) => s.shareCode })
  const dialog = Route.useSearch({ select: (s) => s.dialog })
  const { isOpen, open, close } = useUrlDialog<SharesDialog, SharesSearch>({
    current: dialog,
    navigate,
    clearKeys: ['shareCode'],
  })

  const isUnassign = isOpen('unassign')
  const isHistory = isOpen('history')
  const activeShare = dialogShareCode
    ? shares.find((s) => s.shareCode === dialogShareCode)
    : undefined

  return (
    <PageContainer>
      <header className="flex flex-col gap-2">
        <span className="font-semibold text-primary text-xs uppercase tracking-wider">
          {m.user_role_admin()}
        </span>
        <h1 className="font-bold text-3xl tracking-tight text-balance md:text-4xl">
          {m.share_manage_title()}
        </h1>
        <p className="text-muted-foreground text-sm">{m.share_manage_description()}</p>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {shares.map((share) => (
          <ShareCard
            key={share.shareCode}
            share={share}
            onAssign={() =>
              navigate({
                to: '/admin/shares/assign/$shareCode',
                params: { shareCode: share.shareCode },
              })
            }
            onUnassign={() => open('unassign', { shareCode: share.shareCode })}
            onHistory={() => open('history', { shareCode: share.shareCode })}
          />
        ))}
      </div>

      <UnassignShareDialog
        open={isUnassign && !!activeShare}
        onOpenChange={(o) => {
          if (!o) close()
        }}
        share={activeShare}
      />

      <AssignmentHistorySheet
        open={isHistory && !!dialogShareCode}
        onOpenChange={(o) => {
          if (!o) close()
        }}
        shareCode={dialogShareCode}
      />
    </PageContainer>
  )
}
