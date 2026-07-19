import { createFileRoute } from '@tanstack/react-router'
import { handleShellyWebhook } from '~/lib/sensor/shellyWebhook'

// Public GET receiver for Shelly H&T Gen3 webhooks (the device can't send
// custom headers, so auth is a shared token in the query string). Outside the
// `_authenticated` guard, like api/log.ts. All logic lives in the testable
// handler; this file is just the route binding.
export const Route = createFileRoute('/api/webhooks/shelly')({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => handleShellyWebhook(request),
    },
  },
})
