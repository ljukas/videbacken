import { afterEach, describe, expect, it, vi } from 'vitest'
import queueConsumerPlugin from '../server/plugins/queueConsumer'

// The dispatcher, replaced by a spy. `loaded` counts the module's evaluations:
// the plugin must not load it (and with it ~/lib/db) until a message arrives.
const { dispatchQueueMessage, loaded } = vi.hoisted(() => ({
  dispatchQueueMessage: vi.fn(async () => {}),
  loaded: { count: 0 },
}))
vi.mock('~/lib/queue', () => {
  loaded.count += 1
  return { dispatchQueueMessage }
})

type NitroApp = Parameters<typeof queueConsumerPlugin>[0]
type QueueHook = (event: {
  message: unknown
  metadata: { topicName: string; messageId: string; deliveryCount: number }
}) => Promise<void>

// Just enough of Nitro's app for the plugin: a hooks registry we can fire by hand.
function fakeNitroApp() {
  const queueHooks: QueueHook[] = []
  const app = {
    hooks: {
      hook: (name: string, fn: QueueHook) => {
        if (name === 'vercel:queue') queueHooks.push(fn)
        return () => {}
      },
    },
  } as unknown as NitroApp
  return { app, queueHooks }
}

const delivery = {
  message: { fileId: 'f1' },
  metadata: { topicName: 'blurhash', messageId: 'm1', deliveryCount: 2 },
}

describe('queueConsumer plugin', () => {
  afterEach(() => {
    dispatchQueueMessage.mockReset()
  })

  it('loads the dispatcher on the first message, not when it registers', async () => {
    const { app, queueHooks } = fakeNitroApp()
    queueConsumerPlugin(app)
    expect(queueHooks).toHaveLength(1)
    expect(loaded.count).toBe(0)

    await queueHooks[0](delivery)
    expect(loaded.count).toBe(1)
  })

  it('dispatches the message by topic with its delivery metadata', async () => {
    const { app, queueHooks } = fakeNitroApp()
    queueConsumerPlugin(app)

    await queueHooks[0](delivery)
    expect(dispatchQueueMessage).toHaveBeenCalledWith(
      'blurhash',
      { fileId: 'f1' },
      {
        messageId: 'm1',
        deliveryCount: 2,
      },
    )
  })

  it("lets the dispatcher's throw through, so Vercel redelivers", async () => {
    const { app, queueHooks } = fakeNitroApp()
    queueConsumerPlugin(app)
    dispatchQueueMessage.mockRejectedValueOnce(new Error('transient'))

    await expect(queueHooks[0](delivery)).rejects.toThrow('transient')
  })
})
