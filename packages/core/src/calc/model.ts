/**
 * The calculation input and output. The input shapes are defined once, in
 * `schema/shapes.ts`, with each field's EN 16931 business term (BT) or group
 * (BG); the types here are inferred from them. The computed shapes carry
 * `Decimal`s and never leave the core.
 *
 * Amounts cross this boundary as decimal strings ("1300.00"), never numbers.
 */
import type { Decimal } from "../money/decimal.ts";
import type { Infer } from "../schema/dsl.ts";
import type * as S from "../schema/shapes.ts";

export type InvoiceInput = Infer<typeof S.InvoiceInput>;
export type LineInput = Infer<typeof S.LineInput>;
export type Adjustment = Infer<typeof S.Adjustment>;
export type DocumentAdjustment = Infer<typeof S.DocumentAdjustment>;
export type TaxInput = Infer<typeof S.TaxInput>;
/**
 * How a jurisdiction rounds. Results carry the policy and the core version, so
 * a document issued under them recomputes identically. Change behaviour by
 * publishing a new policy id, never by editing one; `test/golden` pins every
 * published id.
 */
export type Policy = Infer<typeof S.Policy>;
export type DocumentRounding = Infer<typeof S.DocumentRounding>;
export type LineRounding = Infer<typeof S.LineRounding>;

export interface ComputedAdjustment {
    amount: Decimal;
    base?: Decimal;
    percent?: Decimal;
    reason?: string;
    reasonCode?: string;
}

export interface ComputedLine {
    id: string;
    quantity: Decimal;
    /** Quantity × price ÷ base quantity, rounded to the currency. Tax-inclusive under an inclusive policy. */
    gross: Decimal;
    allowances: ComputedAdjustment[];
    charges: ComputedAdjustment[];
    /** BT-131. Always tax-exclusive. */
    net: Decimal;
    taxes: readonly TaxInput[];
}

export interface ComputedDocumentAdjustment extends ComputedAdjustment {
    taxes: readonly TaxInput[];
}

export interface TaxSubtotal {
    scheme: string;
    category: string;
    rate?: Decimal;
    perUnit?: Decimal;
    /** BT-116. */
    taxable: Decimal;
    /** BT-117. */
    tax: Decimal;
    exemptionReason?: string;
    exemptionReasonCode?: string;
}

export interface Totals {
    /** BT-106. */
    lineNet: Decimal;
    /** BT-107. */
    allowances: Decimal;
    /** BT-108. */
    charges: Decimal;
    /** BT-109. */
    taxExclusive: Decimal;
    /** BT-110. */
    tax: Decimal;
    /** BT-112. */
    taxInclusive: Decimal;
    /** BT-113. */
    prepaid: Decimal;
    /** BT-114. */
    rounding: Decimal;
    /** BT-115. */
    payable: Decimal;
}

export interface ComputedInvoice {
    policy: Policy;
    /** The library version that computed it. */
    core: string;
    currency: string;
    /** Decimal places of every amount: the currency's ISO 4217 minor unit when computed. */
    scale: number;
    lines: ComputedLine[];
    allowances: ComputedDocumentAdjustment[];
    charges: ComputedDocumentAdjustment[];
    /** BG-23, in first-seen order. */
    taxes: TaxSubtotal[];
    totals: Totals;
}
