import { ORPCError } from '@orpc/server'
import { describe, expect, test, vi } from 'vitest'
import type { Logger } from '~/lib/logger'
import { logRpcError } from './logRpcError'

function spyLogger() {
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  }
  return log as typeof log & Logger
}

describe('logRpcError', () => {
  test('logs UNAUTHORIZED at debug', () => {
    const log = spyLogger()
    logRpcError(log, new ORPCError('UNAUTHORIZED'))
    expect(log.debug).toHaveBeenCalledWith('rpc rejected', {
      code: 'UNAUTHORIZED',
      status: 401,
      defined: false,
    })
    expect(log.error).not.toHaveBeenCalled()
  })

  test('logs a defined 4xx domain error at info with its code', () => {
    const log = spyLogger()
    logRpcError(log, new ORPCError('DEVICE_NOT_FOUND', { status: 404, defined: true }))
    expect(log.info).toHaveBeenCalledWith('rpc rejected', {
      code: 'DEVICE_NOT_FOUND',
      status: 404,
      defined: true,
    })
    expect(log.error).not.toHaveBeenCalled()
  })

  test('logs an input-validation BAD_REQUEST at warn with issue paths, not the input', () => {
    const log = spyLogger()
    const error = new ORPCError('BAD_REQUEST', {
      message: 'Input validation failed',
      data: {
        issues: [
          { message: 'Expected number', path: ['range', { key: 'from' }] },
          { message: 'Required', path: ['id'] },
        ],
      },
      cause: Object.assign(new Error('Input validation failed'), { data: { id: 'secret-input' } }),
    })
    logRpcError(log, error)
    expect(log.warn).toHaveBeenCalledWith('rpc input rejected', {
      code: 'BAD_REQUEST',
      status: 400,
      defined: false,
      issues: [
        { path: 'range.from', message: 'Expected number' },
        { path: 'id', message: 'Required' },
      ],
    })
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('secret-input')
  })

  test('logs a BAD_REQUEST without issues at info', () => {
    const log = spyLogger()
    logRpcError(log, new ORPCError('BAD_REQUEST'))
    expect(log.info).toHaveBeenCalledOnce()
    expect(log.warn).not.toHaveBeenCalled()
  })

  test('logs FORBIDDEN at info', () => {
    const log = spyLogger()
    logRpcError(log, new ORPCError('FORBIDDEN'))
    expect(log.info).toHaveBeenCalledOnce()
  })

  test('logs a 5xx ORPCError at error with the error attached', () => {
    const log = spyLogger()
    const error = new ORPCError('INTERNAL_SERVER_ERROR')
    logRpcError(log, error)
    expect(log.error).toHaveBeenCalledWith('orpc handler error', { error })
  })

  test('logs an unknown throw at error with the error attached', () => {
    const log = spyLogger()
    const error = new Error('db down')
    logRpcError(log, error)
    expect(log.error).toHaveBeenCalledWith('orpc handler error', { error })
    expect(log.info).not.toHaveBeenCalled()
  })
})
