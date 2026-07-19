// Side-effect import: installs the locale-delegating Zod error map for the
// /api/rpc HTTP path, where router.tsx (the SSR entry that otherwise loads it)
// is never evaluated.
import '~/lib/zodLocale'
import { healthRouter } from './procedures/health'
import { imageRouter } from './procedures/image'
import { presenceRouter } from './procedures/presence'
import { realtimeRouter } from './procedures/realtime'
import { sensorRouter } from './procedures/sensor'
import { userRouter } from './procedures/user'

export const appRouter = {
  health: healthRouter,
  image: imageRouter,
  presence: presenceRouter,
  realtime: realtimeRouter,
  sensor: sensorRouter,
  user: userRouter,
}

export type AppRouter = typeof appRouter
