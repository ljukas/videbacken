import { beforeEach, describe, expect, it, vi } from 'vitest'
import type queueConsumerPluginType from '../server/plugins/queueConsumer'

// The dispatcher, replaced by a spy. `loaded` counts the module's evaluations:
// the plugin must not load it (and with it ~/lib/db) until a message arrives.
// Each test re-imports the plugin after `vi.resetModules()`, so a static import
// would evaluate the mock again whatever the test order.
const { dispatchQueueMessage, loaded } = vi.hoisted(() => ({
  dispatchQueueMessage: vi.fn(async () => {}),
  loaded: { count: 0 },
}))
vi.mock('~/lib/queue', () => {
  loaded.count += 1
  return { dispatchQueueMessage }
})

type NitroApp = Parameters<typeof queueConsumerPluginType>[0]
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

// The plugin, freshly evaluated (as a new instance would load it).
async function loadPlugin() {
  return (await import('../server/plugins/queueConsumer')).default
}

describe('queueConsumer plugin', () => {
  beforeEach(() => {
    vi.resetModules()
    loaded.count = 0
    dispatchQueueMessage.mockReset()
  })

  it('loads the dispatcher on the first message, not when it registers', async () => {
    const { app, queueHooks } = fakeNitroApp()
    const plugin = await loadPlugin()
    plugin(app)
    expect(queueHooks).toHaveLength(1)
    expect(loaded.count).toBe(0)

    await queueHooks[0](delivery)
    expect(loaded.count).toBe(1)
  })

  it('dispatches the message by topic with its delivery metadata', async () => {
    const { app, queueHooks } = fakeNitroApp()
    const plugin = await loadPlugin()
    plugin(app)

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
    const plugin = await loadPlugin()
    plugin(app)
    dispatchQueueMessage.mockRejectedValueOnce(new Error('transient'))

    await expect(queueHooks[0](delivery)).rejects.toThrow('transient')
  })
})
