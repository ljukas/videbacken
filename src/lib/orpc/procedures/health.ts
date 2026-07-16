import { publicProcedure } from '~/lib/orpc/context'

export const healthRouter = {
  ping: publicProcedure.handler(() => ({ ok: true, at: new Date() })),
}
