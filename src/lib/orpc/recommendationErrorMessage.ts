import type { RecommendationDomainErrorCode } from '~/lib/services/recommendation'
import { m } from '~/paraglide/messages'

/** Localize a typed recommendation error code. */
export function recommendationErrorMessage(code: RecommendationDomainErrorCode): string {
  switch (code) {
    case 'NOT_FOUND':
      return m.recommendation_error_not_found()
    case 'CANNOT_EDIT_OTHERS_RECOMMENDATION':
      return m.recommendation_error_edit_others()
    case 'CANNOT_DELETE_OTHERS_RECOMMENDATION':
      return m.recommendation_error_delete_others()
    case 'NO_PHOTOS':
      return m.recommendation_error_no_photos()
    case 'TOO_MANY_PHOTOS':
      return m.recommendation_error_too_many_photos()
    case 'DUPLICATE_PHOTOS':
      return m.recommendation_error_duplicate_photos()
    case 'DUPLICATE_TAGS':
      return m.recommendation_error_duplicate_tags()
  }
}
