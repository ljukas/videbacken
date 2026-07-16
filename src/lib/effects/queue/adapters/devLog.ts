import { logger } from '~/lib/logger/server'
import type { QueueEffects } from '../queue'

export const devLog: QueueEffects = {
  async publish(topic, payload) {
    logger.info('queue publish (devLog)', { topic, payload })
  },
}
