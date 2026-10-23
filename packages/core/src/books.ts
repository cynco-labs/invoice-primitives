/**
 * Books: one tenant's documents behind a backend. Every backend (in memory,
 * Convex, a Durable Object) offers this shape and passes the same conformance
 * suite (`@invoice-primitives/core/testing`). Each method is one transaction.
 */
import type { CreditNoteInput } from "./document/credit.ts";
import { defaultNumbering, type Numbering } from "./document/execute.ts";
import { InvoiceError } from "./errors.ts";
import type { DocumentEvent, DocumentState, DraftData, Settlement } from "./document/types.ts";

export interface StoredEvent {
    /** Position in the tenant's log, from 1, with no gaps. */
    position: number;
    documentId: string;
    /** The document's version after this event. */
    version: number;
    at: string;
    event: DocumentEvent;
}

/** A tenant's settings. Every backend stores them per tenant. */
export interface Settings {
    /** The seller's IANA time zone: an issue date is the seller's calendar date. Default "UTC". */
    timeZone?: string;
    /** How numbers read. Default INV-{yyyy}-00001 and CN-{yyyy}-00001. */
    numbering?: Numbering;
}

export interface Books {
    /** Replaces the given settings, keeping the others. */
    configure(settings: Settings): Promise<void>;
    create(id: string, data: DraftData): Promise<DocumentState>;
    update(id: string, data: DraftData): Promise<DocumentState>;
    discard(id: string): Promise<DocumentState>;
    /** Allocates the next number in the document's series, in the same transaction. */
    issue(id: string): Promise<DocumentState>;
    void(id: string, reason: string): Promise<DocumentState>;
    settle(id: string, settlement: Omit<Settlement, "reversed">): Promise<DocumentState>;
    reverseSettlement(id: string, settlementId: string, reason: string): Promise<DocumentState>;
    requestDelivery(id: string, delivery: { id: string; channel: string; to: string }): Promise<DocumentState>;
    completeDelivery(id: string, deliveryId: string, status: "delivered" | "failed", detail?: string): Promise<DocumentState>;
    credit(invoiceId: string, note: { id: string; input: CreditNoteInput }): Promise<{ invoice: DocumentState; note: DocumentState }>;
    get(id: string): Promise<DocumentState | undefined>;
    events(after?: number, limit?: number): Promise<StoredEvent[]>;
}

/** Refuses settings a backend must not store. */
export function checkSettings(settings: Settings): void {
    if (settings.timeZone !== undefined) {
        try {
            new Intl.DateTimeFormat("en", { timeZone: settings.timeZone });
        } catch {
            throw new InvoiceError("invalid-argument", "timeZone", `${settings.timeZone} is not an IANA time zone`);
        }
    }
    if (settings.numbering !== undefined) {
        for (const kind of Object.keys(defaultNumbering) as (keyof Numbering)[]) {
            const format = settings.numbering[kind];
            if (!format || typeof format.prefix !== "string" || !(Number.isInteger(format.digits) && format.digits >= 1 && format.digits <= 12)) {
                throw new InvoiceError("invalid-argument", `numbering.${kind}`, "a prefix and 1 to 12 digits");
            }
        }
    }
}

/** The largest page `events` returns. */
export const MAX_PAGE = 1000;

/** `events` paging, the same in every backend: after a position from 0, 1 to MAX_PAGE events. */
export function checkPage(after = 0, limit = 100): { after: number; limit: number } {
    if (!Number.isSafeInteger(after) || after < 0) throw new InvoiceError("invalid-argument", "after", "a log position is a whole number from 0");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new InvoiceError("invalid-argument", "limit", `a page is 1 to ${MAX_PAGE} events`);
    return { after, limit };
}
