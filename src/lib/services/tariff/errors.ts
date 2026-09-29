export type TariffDomainErrorCode =
  // An update/delete targeted a tariff period id that does not exist.
  | 'TARIFF_NOT_FOUND'
  // Another period already starts on this `valid_from` day.
  | 'TARIFF_VALID_FROM_TAKEN'
  // An amount is not a finite number within its allowed range (markup
  // −1000…1000 öre, grid transfer/energy tax 0…1000 öre, VAT 0…100 %).
  | 'TARIFF_INVALID_VALUE'
  // `valid_from` is not a real 'YYYY-MM-DD' calendar day.
  | 'TARIFF_INVALID_DATE'

export class TariffDomainError extends Error {
  constructor(public readonly code: TariffDomainErrorCode) {
    super(code)
    this.name = 'TariffDomainError'
  }
}
