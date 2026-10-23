/**
 * The reference backend: books in memory. Small enough to read in one sitting,
 * and the pattern every other backend follows:
 *
 *   in one transaction: load the state → (allocate a number) → execute → save state and events
 */
import { checkPage, type Books, type StoredEvent } from "./books.ts";
import { creditInvoice, creditNoteData } from "./document/credit.ts";
import { execute, numberingFor, type Context } from "./document/execute.ts";
import { checkSettings, contextFor, expand, type Settings } from "./document/input.ts";
import { createRegistry, type Registry } from "./pack.ts";
import { bundledPacks } from "./packs/index.ts";
import type { Command, DocumentEvent, DocumentState } from "./document/types.ts";
import { InvoiceError } from "./errors.ts";

export interface BooksConfig extends Settings {
    /** The country packs. Defaults to the bundled ones. */
    registry?: Registry;
    /** The clock; tests pin it. */
    now?: () => string;
}

export function createMemoryBooks(config: BooksConfig = {}): Books {
    const { registry = createRegistry(bundledPacks), now, ...initial } = config;
    let docs = new Map<string, DocumentState>();
    let sequences = new Map<string, number>();
    let numbers = new Map<string, string>();
    const log: StoredEvent[] = [];
    checkSettings(initial, registry);
    let settings: Settings = initial;

    const context = (): Context => contextFor(settings, registry, now?.() ?? new Date().toISOString());

    /** Runs `fn` atomically: on a throw, documents, sequences and the log are as they were. */
    const transaction = async <T>(fn: (ctx: Context) => T): Promise<T> => {
        const saved = { docs: new Map(docs), sequences: new Map(sequences), numbers: new Map(numbers), length: log.length };
        try {
            return fn(context());
        } catch (e) {
            docs = saved.docs;
            sequences = saved.sequences;
            numbers = saved.numbers;
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
        if ("number" in state && numbers.get(state.number) !== state.id) {
            if (numbers.has(state.number)) throw new InvoiceError("duplicate-number", "number", `number ${state.number} is taken`);
            numbers.set(state.number, state.id);
        }
        docs.set(state.id, state);
        events.forEach((event, i) =>
            log.push({ position: log.length + 1, documentId: state.id, version: state.version - events.length + i + 1, at: ctx.now, event }),
        );
    };

    const run = (id: string, command: Command | ((ctx: Context) => Command)) =>
        transaction((ctx) => {
            const before = docs.get(id);
            const { state, events } = execute(before, typeof command === "function" ? command(ctx) : command, ctx);
            save(ctx, before, state, events);
            if (!state) throw new InvoiceError("not-found", "id", `no document ${id}`);
            return state;
        });

    return {
        configure: async (next) => {
            checkSettings(next, registry);
            settings = { ...settings, ...next };
        },
        create: (document) => {
            const id = document.id ?? crypto.randomUUID();
            return run(id, (ctx) => ({ type: "create", id, data: expand(document, ctx) }));
        },
        update: (id, document) => run(id, (ctx) => ({ type: "update", data: expand(document, ctx) })),
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
        events: async (after, limit) => {
            const page = checkPage(after, limit);
            return log.slice(page.after, page.after + page.limit);
        },
    };
}
