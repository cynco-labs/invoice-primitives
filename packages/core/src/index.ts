/**
 * Invoice Primitives for applications: books on any backend, exact money,
 * calculation, balances, presentation and country packs. Backend authors also
 * import `@invoice-primitives/core/backend`; generators and shapes are in
 * `@invoice-primitives/core/schema`.
 */
export { Decimal, dec, ROUNDING_MODES, type RoundingMode } from "./money/decimal.ts";
export { allocate } from "./money/allocate.ts";
export { compute, minorUnits, taxKey } from "./calc/compute.ts";
export { verify, type Violation } from "./calc/verify.ts";
export type * from "./calc/model.ts";
export { INVOICE_ERROR_CODES, InvoiceError, isInvoiceErrorCode, type InvoiceErrorCode, type Refusal } from "./errors.ts";
export { CORE } from "./version.ts";
export { newId } from "./id.ts";
export { canVoid, type CountryPack, type NamedTax, type Rule, type RuleCheck, type TaxCategory, type VoidDecision, type Voiding } from "./pack.ts";
export { defaultNumbering, type Numbering } from "./document/execute.ts";
export { balance, type Balance } from "./document/balance.ts";
export type { ListPage, ListQuery, ListStatus, Stage } from "./document/listing.ts";
export { MAX_LIST } from "./schema/shapes.ts";
export type { CreditNoteInput } from "./document/credit.ts";
export { addDays, daysBetween, isDate, localDate } from "./document/dates.ts";
export type * from "./document/types.ts";
export { englishLabels, present, type Labels, type View, type PartyView } from "./present/present.ts";
export { renderHtml, type Brand } from "./present/html.ts";
export { createMemoryBooks, type BooksConfig } from "./memory.ts";
export { EVENT_FORMAT, MAX_DOCUMENT_BYTES, MAX_PAGE, replay, type Books, type BooksOptions, type StoredEvent } from "./books.ts";
export type { NewDocument, NewLine, Settings } from "./document/input.ts";
export { bundledPacks, eu, my, jp, jpPolicy } from "./packs/index.ts";
