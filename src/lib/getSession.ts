import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { logger } from '~/lib/logger/server'
import { auth } from './auth'

export const getSession = createServerFn().handler(async () => {
  const request = getRequest()
  try {
    return await auth.api.getSession({ headers: request.headers })
  } catch (error) {
    logger.warn('getSession failed', { error })
    return null
  }
})
