import { expect, test } from 'vitest'
import type { RecommendationDomainErrorCode } from '~/lib/services/recommendation'
import { recommendationErrorMessage } from './recommendationErrorMessage'

const codes: RecommendationDomainErrorCode[] = [
  'NOT_FOUND',
  'CANNOT_EDIT_OTHERS_RECOMMENDATION',
  'CANNOT_DELETE_OTHERS_RECOMMENDATION',
  'NO_PHOTOS',
  'TOO_MANY_PHOTOS',
  'DUPLICATE_PHOTOS',
]

test('every recommendation error code maps to a non-empty message', () => {
  for (const code of codes) {
    expect(recommendationErrorMessage(code).length).toBeGreaterThan(0)
  }
})
