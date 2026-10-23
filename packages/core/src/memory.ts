/**
 * The reference backend: books in memory. Small enough to read in one sitting,
 * and the pattern every other backend follows:
 *
 *   in one transaction: load the state → (allocate a number) → execute → save state and events
 */
import type { Books, StoredEvent } from "./books.ts";
import { creditInvoice, creditNoteData } from "./document/credit.ts";
import { execute, numberingFor, type Context } from "./document/execute.ts";
import type { Command, DocumentEvent, DocumentState } from "./document/types.ts";
import { InvoiceError } from "./errors.ts";

export type BooksConfig = Omit<Context, "now"> & { now?: () => string };

export function createMemoryBooks(config: BooksConfig): Books {
    let docs = new Map<string, DocumentState>();
    let sequences = new Map<string, number>();
    const log: StoredEvent[] = [];

    const context = (): Context => ({ ...config, now: config.now?.() ?? new Date().toISOString() });

    /** Runs `fn` atomically: on a throw, documents, sequences and the log are as they were. */
    const transaction = async <T>(fn: (ctx: Context) => T): Promise<T> => {
        const saved = { docs: new Map(docs), sequences: new Map(sequences), length: log.length };
        try {
            return fn(context());
        } catch (e) {
            docs = saved.docs;
            sequences = saved.sequences;
            log.length = saved.length;
            throw e;
        }
    };

    const next = (series: string) => {
        const n = (sequences.get(series) ?? 0) + 1;
        sequences.set(series, n);
        return n;
    };

    const save = (ctx: Context, before: DocumentState | undefined, state: DocumentState | undefined, events: DocumentEvent[]) => {
        if (!state || events.length === 0) return;
        if (docs.get(state.id) !== before) throw new Error(`document ${state.id} changed during the transaction`);
        docs.set(state.id, state);
        events.forEach((event, i) =>
            log.push({ position: log.length + 1, documentId: state.id, version: state.version - events.length + i + 1, at: ctx.now, event }),
        );
    };

    const run = (id: string, command: Command) =>
        transaction((ctx) => {
            const before = docs.get(id);
            const { state, events } = execute(before, command, ctx);
            save(ctx, before, state, events);
            if (!state) throw new InvoiceError("not-found", "id", `no document ${id}`);
            return state;
        });

    return {
        create: (id, data) => run(id, { type: "create", id, data }),
        update: (id, data) => run(id, { type: "update", data }),
        discard: (id) => run(id, { type: "discard" }),
        issue: (id) =>
            transaction((ctx) => {
                const before = docs.get(id);
                const plan = before?.status === "draft" ? numberingFor(before.data, ctx) : undefined;
                const { state, events } = execute(before, { type: "issue", number: plan ? plan.format(next(plan.series)) : "" }, ctx);
                save(ctx, before, state, events);
                return state!;
            }),
        void: (id, reason) => run(id, { type: "void", reason }),
        settle: (id, settlement) => run(id, { type: "settle", settlement }),
        reverseSettlement: (id, settlementId, reason) => run(id, { type: "reverse-settlement", settlementId, reason }),
        requestDelivery: (id, delivery) => run(id, { type: "request-delivery", delivery }),
        completeDelivery: (id, deliveryId, status, detail) =>
            run(id, { type: "complete-delivery", deliveryId, status, ...(detail !== undefined && { detail }) }),
        credit: (invoiceId, note) =>
            transaction((ctx) => {
                const invoice = docs.get(invoiceId);
                const existing = docs.get(note.id);
                const plan = invoice?.status === "issued" && !existing ? numberingFor(creditNoteData(invoice, note.input), ctx) : undefined;
                const number = plan ? plan.format(next(plan.series)) : "";
                const result = creditInvoice(invoice, existing, { ...note, number }, ctx);
                save(ctx, invoice, result.invoice.state, result.invoice.events);
                save(ctx, existing, result.note.state, result.note.events);
                return { invoice: result.invoice.state, note: result.note.state };
            }),
        get: async (id) => docs.get(id),
        events: async (after = 0, limit = 100) => log.slice(after, after + limit),
    };
}
