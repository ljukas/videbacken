import { QUEUE_MAX_DELIVERIES } from '~/lib/effects/queue/queue'
import { logger } from '~/lib/logger/server'
import { createQueueDispatcher, type QueueHandlerTable } from './dispatch'
import { blurhashHandler } from './handlers/blurhash'
import { emailIntegrationSyncAlertHandler } from './handlers/emailIntegrationSyncAlert'
import { emailUserInvitedHandler } from './handlers/emailUserInvited'
import { heicTranscodeHandler } from './handlers/heicTranscode'

export {
  PermanentQueueError,
  type QueueHandler,
  type QueueHandlerContext,
  type QueueMessageMeta,
} from './dispatch'

/** Every topic's handler. Adding a `QueueTopic` without an entry here fails to compile. */
export const queueHandlers: QueueHandlerTable = {
  blurhash: blurhashHandler,
  email_user_invited: emailUserInvitedHandler,
  heic_transcode: heicTranscodeHandler,
  email_integration_sync_alert: emailIntegrationSyncAlertHandler,
}

/**
 * Dispatches one inbound message: called by the production consumer
 * (`server/plugins/queueConsumer.ts`) and the dev BullMQ worker
 * (`scripts/devQueueWorker.ts`). Contract in `./dispatch.ts`.
 */
export const dispatchQueueMessage = createQueueDispatcher(queueHandlers, {
  log: logger,
  maxDeliveries: QUEUE_MAX_DELIVERIES,
})
