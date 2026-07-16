import { MemoryPublisher } from '@orpc/experimental-publisher/memory'
import type { RealtimeEffects, RealtimeEnvelope } from '../realtime'

const CHANNEL = 'event' as const

export function createInMemoryRealtime(): RealtimeEffects {
  const publisher = new MemoryPublisher<{ [CHANNEL]: RealtimeEnvelope }>()
  return {
    async publish(event, opts) {
      publisher.publish(CHANNEL, { event, source: opts?.source })
    },
    subscribe({ signal }) {
      return publisher.subscribe(CHANNEL, { signal })
    },
  }
}

export const inMemory = createInMemoryRealtime()
