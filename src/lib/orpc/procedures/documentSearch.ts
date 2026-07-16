import { z } from 'zod'
import { protectedProcedure } from '~/lib/orpc/context'
import * as documentSearchService from '~/lib/services/documentSearch'

export const documentSearchRouter = {
  search: protectedProcedure
    .input(z.object({ q: z.string().min(1).max(200) }))
    .handler(({ input }) => documentSearchService.search(input.q)),
}
