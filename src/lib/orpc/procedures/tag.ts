import * as tagService from '~/lib/services/tag'
import { protectedProcedure } from '../context'

export const tagRouter = {
  list: protectedProcedure.handler(() => tagService.listTags()),
}
