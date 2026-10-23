/**
 * The document primitive: an invoice or credit note as plain data, the
 * commands that change it, and the events that record each change.
 *
 * Everything here is JSON. Amounts are decimal strings, dates are ISO
 * calendar dates ("2026-10-23"), instants are ISO timestamps. A backend stores
 * state and events as they are.
 */
import type { DocumentAdjustment, LineInput } from "../calc/model.ts";

export type DocumentKind = "invoice" | "credit-note";

export interface Party {
    /** BT-27 / BT-44. */
    name: string;
    /** Tax and registration identifiers: VAT, TIN, BRN, SST... (BT-29..32, BT-46..48). */
    ids?: readonly { scheme: string; value: string }[];
    email?: string;
    address?: Address;
}

export interface Address {
    lines: readonly string[];
    city?: string;
    postalCode?: string;
    region?: string;
    /** ISO 3166-1 alpha-2. */
    country: string;
}

export interface Line extends LineInput {
    /** BT-153. */
    name: string;
    /** BT-154. */
    description?: string;
    /** BT-130, a UN/ECE Recommendation 20 code ("C62" one, "HUR" hour). */
    unit?: string;
}

/** What a draft says. Free to change until the document is issued. */
export interface DraftData {
    kind: DocumentKind;
    /** A policy id from a registered country pack: how the document is calculated. */
    policy: string;
    /** BT-5. */
    currency: string;
    seller: Party;
    buyer: Party;
    lines: readonly Line[];
    allowances?: readonly DocumentAdjustment[];
    charges?: readonly DocumentAdjustment[];
    /** BT-2. Defaults to the day of issue in the seller's time zone. */
    issueDate?: string;
    /** BT-9 as a date, or payment terms in days after issue. Defaults to the issue date. */
    due?: { date: string } | { days: number };
    /** BT-10. */
    buyerReference?: string;
    /** BT-13. */
    orderReference?: string;
    /** BT-22. */
    note?: string;
    /** BT-25: for a credit note, the id of the invoice it corrects. */
    corrects?: string;
}

/** The figures fixed at issue: what the document legally says, as strings. */
export interface Figures {
    policy: string;
    core: string;
    scale: number;
    lines: readonly { id: string; net: string }[];
    taxes: readonly {
        scheme: string;
        category: string;
        rate?: string;
        perUnit?: string;
        taxable: string;
        tax: string;
        exemptionReason?: string;
        exemptionReasonCode?: string;
    }[];
    totals: {
        lineNet: string;
        allowances: string;
        charges: string;
        taxExclusive: string;
        tax: string;
        taxInclusive: string;
        prepaid: string;
        rounding: string;
        payable: string;
    };
}

/** Money that settled part of an issued document: a payment, a credit note, a write-off. */
export interface Settlement {
    /** Caller-chosen and unique per document. Repeating a settle with the same id is a no-op. */
    id: string;
    kind: "payment" | "credit" | "write-off";
    /** Positive, in the document's currency. */
    amount: string;
    /** The calendar date the money moved. */
    date: string;
    /** A bank reference, payment method, or the id of the other document. */
    reference?: string;
    reversed?: { reason: string; at: string };
}

export interface Delivery {
    id: string;
    /** "email", "link", "peppol"... */
    channel: string;
    to: string;
    requestedAt: string;
    outcome?: { status: "delivered" | "failed"; at: string; detail?: string };
}

interface Base {
    id: string;
    /** The number of events applied. A backend saves only when this is still what it loaded. */
    version: number;
    data: DraftData;
}

interface IssuedFields {
    /** BT-1. */
    number: string;
    issueDate: string;
    dueDate: string;
    figures: Figures;
    settlements: readonly Settlement[];
    deliveries: readonly Delivery[];
}

export type DraftState = Base & { status: "draft" };
export type DiscardedState = Base & { status: "discarded" };
export type IssuedState = Base & IssuedFields & { status: "issued" };
export type VoidState = Base & IssuedFields & { status: "void"; voided: { reason: string; at: string } };
export type DocumentState = DraftState | DiscardedState | IssuedState | VoidState;

export type Command =
    | { type: "create"; id: string; data: DraftData }
    | { type: "update"; data: DraftData }
    | { type: "discard" }
    /** `number` comes from the backend's sequence, allocated in the same transaction (see `numberFor`). */
    | { type: "issue"; number: string }
    | { type: "void"; reason: string }
    | { type: "settle"; settlement: Omit<Settlement, "reversed"> }
    | { type: "reverse-settlement"; settlementId: string; reason: string }
    | { type: "request-delivery"; delivery: { id: string; channel: string; to: string } }
    | { type: "complete-delivery"; deliveryId: string; status: "delivered" | "failed"; detail?: string };

export type DocumentEvent =
    | { type: "created"; id: string; data: DraftData }
    | { type: "updated"; data: DraftData }
    | { type: "discarded" }
    | { type: "issued"; number: string; issueDate: string; dueDate: string; figures: Figures }
    | { type: "voided"; reason: string; at: string }
    | { type: "settled"; settlement: Settlement }
    | { type: "settlement-reversed"; settlementId: string; reason: string; at: string }
    | { type: "delivery-requested"; delivery: Delivery }
    | { type: "delivery-completed"; deliveryId: string; status: "delivered" | "failed"; at: string; detail?: string };
