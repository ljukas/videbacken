import { createFileRoute } from '@tanstack/react-router'
import { auth } from '~/lib/auth'
import { storage } from '~/lib/effects'
import { isRemoteOriginPathname } from '~/lib/effects/storage'
import { remoteOriginUnavailable } from '~/lib/files/remoteOrigin'
import { createRequestLogger } from '~/lib/logger/server'
import * as documentService from '~/lib/services/document'
import { joinFilename } from '~/utils/filename'

export const Route = createFileRoute('/api/files/download/$id')({
  server: {
    handlers: {
      GET: async ({ request, params }: { request: Request; params: { id: string } }) => {
        const { log } = createRequestLogger(request)
        const session = await auth.api.getSession({ headers: request.headers })
        if (!session?.user) {
          return new Response('Unauthorized', { status: 401 })
        }

        const row = await documentService.findActiveById(params.id)
        if (!row) {
          return new Response('Not Found', { status: 404 })
        }

        // Dev-only: a prod-origin file surfaced through the Neon-branched DB whose
        // bytes were never synced into local RustFS. Explain instead of redirecting
        // to a signed URL that 404s. No overhead in prod (flag is always false).
        if (isRemoteOriginPathname(row.file.pathname)) {
          const exists = await storage.head(row.file.access, row.file.pathname)
          if (!exists) {
            log.info('remote-origin document not in local storage', {
              documentId: row.document.id,
              pathname: row.file.pathname,
            })
            return remoteOriginUnavailable()
          }
        }

        // Download under the document's current display name (base + extension)
        // rather than the immutable storage pathname.
        const url = await storage.getReadUrl(row.file.access, row.file.pathname, 60, {
          downloadFilename: joinFilename(row.document),
        })
        log.info('document download', {
          documentId: row.document.id,
          fileId: row.file.id,
          userId: session.user.id,
        })
        return new Response(null, {
          status: 302,
          headers: { Location: url },
        })
      },
    },
  },
})
