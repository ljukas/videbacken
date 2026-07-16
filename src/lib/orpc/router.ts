// Side-effect import: installs the locale-delegating Zod error map for the
// /api/rpc HTTP path, where router.tsx (the SSR entry that otherwise loads it)
// is never evaluated.
import '~/lib/zodLocale'
import { bookingRouter } from './procedures/booking'
import { documentRouter } from './procedures/document'
import { binRouter } from './procedures/documentBin'
import { documentSearchRouter } from './procedures/documentSearch'
import { folderRouter } from './procedures/folder'
import { healthRouter } from './procedures/health'
import { imageRouter } from './procedures/image'
import { presenceRouter } from './procedures/presence'
import { realtimeRouter } from './procedures/realtime'
import { recommendationRouter } from './procedures/recommendation'
import { seasonRouter } from './procedures/season'
import { shareRouter } from './procedures/share'
import { tagRouter } from './procedures/tag'
import { userRouter } from './procedures/user'

export const appRouter = {
  bin: binRouter,
  booking: bookingRouter,
  document: documentRouter,
  documentSearch: documentSearchRouter,
  folder: folderRouter,
  health: healthRouter,
  image: imageRouter,
  presence: presenceRouter,
  realtime: realtimeRouter,
  recommendation: recommendationRouter,
  season: seasonRouter,
  share: shareRouter,
  tag: tagRouter,
  user: userRouter,
}

export type AppRouter = typeof appRouter
