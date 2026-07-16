export type RecommendationDomainErrorCode =
  | 'NOT_FOUND'
  | 'CANNOT_EDIT_OTHERS_RECOMMENDATION'
  | 'CANNOT_DELETE_OTHERS_RECOMMENDATION'
  | 'NO_PHOTOS'
  | 'TOO_MANY_PHOTOS'
  | 'DUPLICATE_PHOTOS'
  | 'DUPLICATE_TAGS'

export class RecommendationDomainError extends Error {
  constructor(public readonly code: RecommendationDomainErrorCode) {
    super(code)
    this.name = 'RecommendationDomainError'
  }
}

export const MIN_PHOTOS = 1
export const MAX_PHOTOS = 10
