import { logger } from '~/lib/logger/server'
import type { StorageEffects } from '../storage'

/**
 * Test / offline adapter. Logs every call via the structured logger; never
 * touches the network. Returns stub values that satisfy the interface so
 * upstream code (procedures, components, tests) can exercise the full flow
 * without a live Blob token.
 */
export const devLog: StorageEffects = {
  async mintUploadToken({ access, pathname, contentType, maxBytes }) {
    logger.info('storage mintUploadToken (devLog)', { access, pathname, contentType, maxBytes })
    return { pathname, upload: { kind: 'vercel-blob-client', clientToken: 'devlog-stub' } }
  },

  async head(access, pathname) {
    logger.info('storage head (devLog)', { access, pathname })
    return {
      url: `https://devlog.local/${pathname}`,
      contentType: 'application/octet-stream',
      size: 0,
    }
  },

  async delete(access, pathname) {
    logger.info('storage delete (devLog)', { access, pathname })
  },

  async put(access, pathname, bytes, contentType) {
    logger.info('storage put (devLog)', { access, pathname, contentType, size: bytes.byteLength })
  },

  async copy(access, fromPathname, toPathname, contentType) {
    logger.info('storage copy (devLog)', { access, fromPathname, toPathname, contentType })
  },

  async getReadUrl(access, pathname, ttlSeconds, opts) {
    logger.info('storage getReadUrl (devLog)', {
      access,
      pathname,
      ttlSeconds,
      downloadFilename: opts?.downloadFilename,
    })
    return `https://devlog.local/${pathname}?ttl=${ttlSeconds}`
  },
}
