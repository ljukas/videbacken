import { send } from '@vercel/queue'
import type { QueueEffects } from '../queue'

/**
 * Production adapter. `send()` auto-detects the region from
 * `VERCEL_REGION` and uses OIDC for auth — both are injected by the
 * platform on deployed functions, so no env-var wiring is required.
 */
export const vercelQueue: QueueEffects = {
  async publish(topic, payload) {
    await send(topic, payload)
  },
}
