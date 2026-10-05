// Side-effect import: installs the locale-delegating Zod error map for the
// /api/rpc HTTP path, where router.tsx (the SSR entry that otherwise loads it)
// is never evaluated.
import '~/lib/zodLocale'
import { energyRouter } from './procedures/energy'
import { evChargingRouter } from './procedures/evCharging'
import { healthRouter } from './procedures/health'
import { imageRouter } from './procedures/image'
import { sensorRouter } from './procedures/sensor'
import { tariffRouter } from './procedures/tariff'
import { userRouter } from './procedures/user'

export const appRouter = {
  energy: energyRouter,
  evCharging: evChargingRouter,
  health: healthRouter,
  image: imageRouter,
  sensor: sensorRouter,
  tariff: tariffRouter,
  user: userRouter,
}

export type AppRouter = typeof appRouter
