import { InvoiceError } from "../errors.ts";
import { dec } from "../money/decimal.ts";
import { balance } from "./balance.ts";
import { evolve, execute, issueDateOf, type Context } from "./execute.ts";
import type { DocumentEvent, DocumentState, DraftData, IssuedState } from "./types.ts";

/** What a credit note says of its own: the parties, currency and policy are the invoice's. */
export type CreditNoteInput = Omit<DraftData, "kind" | "corrects" | "correctsNumber" | "seller" | "buyer" | "currency" | "policy">;

export interface Change {
    state: DocumentState;
    events: DocumentEvent[];
}

/**
 * Issues a credit note against an issued invoice and applies it: the note's
 * total settles the invoice and the invoice settles the note. A backend saves
 * both changes in one transaction. `number` comes from `numberingFor` on the
 * note's data, allocated in that same transaction.
 *
 * Repeating it with the same note id is a no-op, and needs no number.
 * A credit larger than what is still owed is refused: refunding a paid
 * invoice is not built yet.
 */
export function creditInvoice(
    invoice: DocumentState | undefined,
    existingNote: DocumentState | undefined,
    note: { id: string; number: string; input: CreditNoteInput },
    ctx: Context,
): { invoice: Change; note: Change } {
    if (!invoice) throw new InvoiceError("not-found", "invoice", "no such invoice");
    if (existingNote) {
        const applied = invoice.status === "issued" && invoice.settlements.some((s) => s.id === `credit:${note.id}` && !s.reversed);
        if (applied && existingNote.data.corrects === invoice.id && existingNote.status === "issued") {
            return { invoice: { state: invoice, events: [] }, note: { state: existingNote, events: [] } };
        }
        throw new InvoiceError("already-exists", "note.id", `document ${note.id} exists`);
    }
    if (invoice.status !== "issued" || invoice.data.kind !== "invoice") {
        throw new InvoiceError("invalid-transition", "invoice", `cannot credit a ${invoice.status} ${invoice.data.kind}`);
    }
    const data = creditNoteData(invoice, note.input);
    const date = issueDateOf(data, ctx);
    if (date < invoice.issueDate) {
        throw new InvoiceError("invalid-date", "note.input.issueDate", `a credit note cannot be dated before its invoice (${invoice.issueDate})`);
    }
    // `create` refuses credit notes, so that this is the only way one exists: created and applied together.
    const created = { state: evolve(undefined, { type: "created", id: note.id, data }), events: [{ type: "created", id: note.id, data } as const] };
    const issued = execute(created.state, { type: "issue", number: note.number }, ctx);
    const issuedNote = issued.state as IssuedState;

    const amount = issuedNote.figures.totals.payable;
    if (dec(amount).sign() <= 0) throw new InvoiceError("invalid-amount", "note.input.lines", "a credit note credits a positive amount");
    const outstanding = balance(invoice, date).outstanding;
    if (dec(amount).cmp(dec(outstanding)) > 0) {
        throw new InvoiceError("credit-exceeds-outstanding", "note", `credit ${amount} exceeds the outstanding ${outstanding}`);
    }

    const settledInvoice = execute(
        invoice,
        { type: "settle", settlement: { id: `credit:${note.id}`, kind: "credit", amount, date, reference: note.id } },
        ctx,
    );
    const settledNote = execute(
        issuedNote,
        { type: "settle", settlement: { id: `applied:${invoice.id}`, kind: "credit", amount, date, reference: invoice.id } },
        ctx,
    );
    return {
        invoice: { state: settledInvoice.state!, events: settledInvoice.events },
        note: { state: settledNote.state!, events: [...created.events, ...issued.events, ...settledNote.events] },
    };
}

export function creditNoteData(invoice: IssuedState, input: CreditNoteInput): DraftData {
    const { seller, buyer, currency, policy } = invoice.data;
    return { ...input, kind: "credit-note", corrects: invoice.id, correctsNumber: invoice.number, seller, buyer, currency, policy };
}
