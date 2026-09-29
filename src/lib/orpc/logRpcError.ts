import { ORPCError } from '@orpc/server'
import { issuePath } from '~/lib/issuePaths'
import type { Logger } from '~/lib/logger'

// Grades an error thrown out of an oRPC procedure (wired as the handler's
// `onError` interceptor in src/routes/api/rpc/$.ts). Expected rejections —
// auth failures, typed domain errors — are client outcomes, not server faults:
// logging them at error level buried real faults.
//   - 401: debug. Polled screens (ADR-0018) hit it every tick once a session expires.
//   - input validation (BAD_REQUEST with issues): warn, with each issue's path and
//     message — usually a stale client or schema drift, i.e. our bug to see.
//   - any other ORPCError < 500: info, with its code (no stack needed).
//   - everything else (unknown throws, 5xx): error, fully serialized.
export function logRpcError(log: Logger, error: unknown): void {
  if (error instanceof ORPCError && error.status < 500) {
    const fields = { code: error.code, status: error.status, defined: error.defined }
    const issues = validationIssues(error)
    if (error.status === 401) log.debug('rpc rejected', fields)
    else if (issues) log.warn('rpc input rejected', { ...fields, issues })
    else log.info('rpc rejected', fields)
    return
  }
  log.error('orpc handler error', { error })
}

// oRPC's input validation throws BAD_REQUEST with `data.issues` (Standard Schema
// issues). Keep only path + message — never the submitted input itself.
function validationIssues(error: ORPCError<string, unknown>) {
  if (error.code !== 'BAD_REQUEST') return null
  const issues = (error.data as { issues?: unknown } | undefined)?.issues
  if (!Array.isArray(issues)) return null
  return issues.slice(0, 10).map((issue: { message?: unknown; path?: unknown }) => ({
    path: Array.isArray(issue.path) ? issuePath(issue.path) : '',
    message: typeof issue.message === 'string' ? issue.message : 'invalid',
  }))
}
