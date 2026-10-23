/**
 * The calculation input and output. Field names follow the EN 16931 semantic
 * model; each carries its business term (BT) or group (BG) so a reader can
 * check it against the norm, PINT, or a national CIUS.
 *
 * Amounts cross this boundary as decimal strings ("1300.00"), never numbers.
 */
import type { Decimal, RoundingMode } from "./decimal.ts";

export interface InvoiceInput {
    /** BT-5. ISO 4217; its minor unit sets the scale of every amount. */
    currency: string;
    /** BG-25. */
    lines: readonly LineInput[];
    /** BG-20. */
    allowances?: readonly DocumentAdjustment[];
    /** BG-21. */
    charges?: readonly DocumentAdjustment[];
    /** BT-113. */
    prepaid?: string;
    /** BT-114, when the seller states it. Otherwise the policy's cash increment derives it. */
    roundingAmount?: string;
}

export interface LineInput {
    /** BT-126. */
    id: string;
    /** BT-129. Negative on a correction line. */
    quantity: string;
    /**
     * BT-146, the item net price per `baseQuantity`. Tax-inclusive when the
     * policy says prices include tax.
     */
    price: string;
    /** BT-149. Defaults to 1. */
    baseQuantity?: string;
    /** BG-27. */
    allowances?: readonly Adjustment[];
    /** BG-28. */
    charges?: readonly Adjustment[];
    /**
     * BG-30. The taxes the line bears, in application order. EN 16931 allows
     * exactly one; the core allows several so compound and per-unit taxes
     * (Malaysian tourism tax, excise) fit the same shape.
     */
    taxes: readonly TaxInput[];
}

/** An allowance or charge: a stated amount, or `percent` of `base`. */
export interface Adjustment {
    /** BT-136 / BT-141 / BT-92 / BT-99. */
    amount?: string;
    /** BT-138 / BT-143 / BT-94 / BT-101. */
    percent?: string;
    /** BT-137 / BT-142 / BT-93 / BT-100. Defaults to the line gross, or the sum of line nets. */
    base?: string;
    reason?: string;
    reasonCode?: string;
}

export interface DocumentAdjustment extends Adjustment {
    /** BT-95 / BT-102. EN 16931 requires the tax category of a document-level adjustment. */
    taxes: readonly TaxInput[];
}

export interface TaxInput {
    /** BT-151's scheme. "VAT" is EN 16931's word for any consumption tax (SST, GST). */
    scheme?: string;
    /** BT-151 / BT-118. UNCL5305 (S, Z, E, AE, K, G, O, L, M) or a national code (PINT MY's SA, SE, TTX). */
    category: string;
    /** BT-152, percent. Absent for a category that levies nothing. */
    rate?: string;
    /** A fixed amount per unit of quantity, instead of a rate. */
    perUnit?: string;
    /** Levied on the line net plus the line's earlier taxes. */
    compound?: boolean;
    /** BT-120. */
    exemptionReason?: string;
    /** BT-121. */
    exemptionReasonCode?: string;
}

/**
 * How a jurisdiction rounds. Results carry `id`, so a document issued under a
 * policy recomputes identically for as long as that policy id exists: change
 * behaviour by publishing a new id, never by editing one.
 */
export interface Policy {
    readonly id: string;
    /**
     * "document": tax per (scheme, category, rate) on the summed taxable
     * amount, rounded once (EN 16931 BR-CO-17, PINT, Japan's qualified invoice).
     * "line": tax per line per tax, rounded each time, then summed.
     */
    readonly taxRounding: "document" | "line";
    readonly mode: RoundingMode;
    /**
     * false: prices are net of tax (EN 16931).
     * "extract": tax = round(gross × rate ÷ (100 + rate)), taxable = gross − tax
     * (Japan; most retail). BR-CO-17 can be a unit off.
     * "reconcile": the taxable amount is chosen so BR-CO-17 holds; a gross no
     * taxable amount reaches leaves its residual in BT-114.
     * Under line rounding both extract per line.
     */
    readonly pricesIncludeTax: false | "extract" | "reconcile";
    /** Round the payable amount to this increment, recording BT-114 (Malaysia: "0.05"). */
    readonly cashIncrement?: string;
}

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
    currency: string;
    lines: ComputedLine[];
    allowances: ComputedDocumentAdjustment[];
    charges: ComputedDocumentAdjustment[];
    /** BG-23, in first-seen order. */
    taxes: TaxSubtotal[];
    totals: Totals;
}
