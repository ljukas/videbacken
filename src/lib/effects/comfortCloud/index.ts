// Step 1a: the client only. Step 1b adds the `comfortCloud` facade and registers it in
// src/lib/effects/index.ts.
export { createComfortCloudClient } from './client'
export {
  type ComfortCloudCallOpts,
  type ComfortCloudCallStats,
  type ComfortCloudClient,
  type ComfortCloudDay,
  type ComfortCloudHistory,
  type ComfortCloudHour,
  type ComfortCloudUnit,
  newCallStats,
} from './comfortCloud'
export { type ComfortCloudCredentialField, ComfortCloudError, type ComfortCloudOp } from './errors'
