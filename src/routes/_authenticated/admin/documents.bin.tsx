import { createFileRoute } from '@tanstack/react-router'
import { Suspense } from 'react'
import { DocumentBin } from '~/components/document/views/DocumentBin'
import { PageContainer } from '~/components/layout/PageContainer'
import { orpc } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

export const Route = createFileRoute('/_authenticated/admin/documents/bin')({
  head: () => ({
    meta: seo({
      title: `${m.meta_bin_title()} | Oceanview`,
      description: m.meta_bin_description(),
    }),
  }),
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(orpc.bin.list.queryOptions())
  },
  component: DocumentBinPage,
})

function DocumentBinPage() {
  return (
    <PageContainer>
      <header className="flex flex-col gap-1">
        <h1 className="font-bold text-3xl tracking-tight text-balance md:text-4xl">
          {m.nav_bin()}
        </h1>
        <p className="text-muted-foreground text-sm">{m.bin_page_description()}</p>
      </header>
      <Suspense
        fallback={<div className="text-muted-foreground text-sm">{m.common_loading()}</div>}
      >
        <DocumentBin />
      </Suspense>
    </PageContainer>
  )
}
