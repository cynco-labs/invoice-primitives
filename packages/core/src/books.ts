/**
 * Books: one tenant's documents behind a backend. Every backend (in memory,
 * Convex, a Durable Object) offers this shape and passes the same conformance
 * suite (`@invoice-primitives/core/testing`). Each method is one transaction.
 */
import type { CreditNoteInput } from "./document/credit.ts";
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

export interface Books {
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
