/**
 * Books: one tenant's documents. `createBooks(store)` runs every command on a
 * backend's `Store`, so the rules live here once:
 *
 *   in one transaction: load → (take a number) → execute → check → save state, listing and events
 *
 * Every backend (in memory, Convex, a Durable Object) is a `Store` and passes
 * the same conformance suite (`@invoice-primitives/core/testing`).
 */
import { creditInvoice, creditNoteData, type CreditNoteInput } from "./document/credit.ts";
import { evolve, execute, numberingFor, type Context } from "./document/execute.ts";
import { checkSettings, contextFor, expand, type NewDocument, type Settings } from "./document/input.ts";
import { collect, listFilter, listingOf, type ListPage, type ListQuery } from "./document/listing.ts";
import type { Command, DeliveryRequest, DeliveryStatus, DocumentEvent, DocumentState, NewSettlement } from "./document/types.ts";
import { InvoiceError } from "./errors.ts";
import { newId } from "./id.ts";
import { registryFor, type CountryPack } from "./pack.ts";
import { integer, parse, string, text, type Infer } from "./schema/dsl.ts";
import * as S from "./schema/shapes.ts";
import type { Reader, Store, Transaction } from "./store.ts";

export type StoredEvent = Infer<typeof S.StoredEvent>;

export interface Books {
    /** Replaces the given settings, keeping the others. */
    configure(settings: Settings): Promise<void>;
    /** A new draft. Fields the tenant's settings supply may be left out; `id` is generated when absent. */
    create(document: NewDocument): Promise<DocumentState>;
    /** Replaces a draft's content, expanded the same way as `create`. */
    update(id: string, document: NewDocument): Promise<DocumentState>;
    discard(id: string): Promise<DocumentState>;
    /** Allocates the next number in the document's series, in the same transaction. */
    issue(id: string): Promise<DocumentState>;
    void(id: string, reason: string): Promise<DocumentState>;
    settle(id: string, settlement: NewSettlement): Promise<DocumentState>;
    reverseSettlement(id: string, settlementId: string, reason: string): Promise<DocumentState>;
    requestDelivery(id: string, delivery: DeliveryRequest): Promise<DocumentState>;
    completeDelivery(id: string, deliveryId: string, status: DeliveryStatus, detail?: string): Promise<DocumentState>;
    credit(invoiceId: string, note: { id: string; input: CreditNoteInput }): Promise<{ invoice: DocumentState; note: DocumentState }>;
    get(id: string): Promise<DocumentState | undefined>;
    /** The issued or void document that holds `number`. */
    getByNumber(number: string): Promise<DocumentState | undefined>;
    /** The tenant's documents, newest first, filtered by kind, status and customer. */
    list(query?: ListQuery): Promise<ListPage>;
    /** The log after position `after`: at most `limit` events, and possibly fewer. Continue from the last position until a page is empty. */
    events(after?: number, limit?: number): Promise<StoredEvent[]>;
    /**
     * Rewrites every document's listing from its state, a page of documents at
     * a time; call again with `next` until it is absent. Run it after a core
     * upgrade whose notes say listings changed. Idempotent.
     */
    rebuildListings(cursor?: string): Promise<{ next?: string }>;
}

export interface BooksOptions {
    /** The country packs, as data. Defaults to the bundled ones; add yours with `[...bundledPacks, mine]`. */
    packs?: readonly CountryPack[] | undefined;
    /** The clock; tests pin it. */
    now?: (() => string) | undefined;
}

/** The largest page `events` returns. */
export const MAX_PAGE = 1000;

/** The shape of events this core writes, recorded on each one. */
export const EVENT_FORMAT = 1;

/**
 * The most a document's state may weigh as JSON. It keeps every document
 * within every backend's row limit (Convex: 1 MiB), so a document that one
 * backend could store, all can; a document that would outgrow it is refused.
 */
export const MAX_DOCUMENT_BYTES = 512 * 1024;

const REBUILD_PAGE = 100;

/** Rebuilds documents from a log, refusing events written in a format newer than this core reads. */
export function replay(events: Iterable<StoredEvent>, into = new Map<string, DocumentState>()): Map<string, DocumentState> {
    let i = 0;
    for (const e of events) {
        const at = `events[${i++}]`;
        if (e.format > EVENT_FORMAT) throw new InvoiceError("unsupported", at, `event format ${e.format} is newer than this core reads (${EVENT_FORMAT})`);
        const before = into.get(e.documentId);
        if (!before && e.event.type !== "created") {
            throw new InvoiceError("invalid-argument", at, `document ${e.documentId} has no earlier events here; replay from its first event (version 1)`);
        }
        into.set(e.documentId, evolve(before, e.event));
    }
    return into;
}

/** Every runtime this library targets has `TextEncoder`; declaring just that keeps the core free of DOM and Node types. */
declare const TextEncoder: new () => { encode(text: string): Uint8Array };
const encoder = new TextEncoder();

/** The size of a state as JSON, encoded only when it might be over the limit: a UTF-16 unit is at most 3 bytes of UTF-8. */
function weighs(json: string): number {
    return json.length * 3 <= MAX_DOCUMENT_BYTES ? json.length : encoder.encode(json).length;
}

export function createBooks(store: Store, options: BooksOptions = {}): Books {
    const registry = registryFor(options.packs);
    const most = (n: number) => Math.min(n, store.maxDocuments ?? n);
    const clock = options.now ?? (() => new Date().toISOString());
    const contextOf = async (tx: Reader) => contextFor(await tx.settings(), registry, clock());

    /** One command: a transaction with the tenant's context, and a log head read once and only if something is saved. */
    const command = <T>(work: (unit: { tx: Transaction; ctx: Context; save: Save }) => Promise<T>): Promise<T> =>
        store.transaction(async (tx) => {
            const ctx = await contextOf(tx);
            let head: number | undefined;
            const save: Save = async (before, state, events) => {
                if (!state || events.length === 0) return;
                if ("number" in state && !(before && "number" in before)) {
                    const holder = await tx.holder(state.number);
                    if (holder !== undefined && holder !== state.id) throw new InvoiceError("duplicate-number", "number", `number ${state.number} is taken`);
                }
                const bytes = weighs(JSON.stringify(state));
                if (bytes > MAX_DOCUMENT_BYTES) {
                    throw new InvoiceError("too-large", "", `document ${state.id} would weigh ${bytes} bytes, over the ${MAX_DOCUMENT_BYTES} every backend can store`);
                }
                head ??= await tx.head();
                const first = head + 1;
                head += events.length;
                await tx.write({
                    state,
                    expected: before?.version,
                    listing: listingOf(state),
                    events: events.map((event, i) => ({
                        position: first + i,
                        format: EVENT_FORMAT,
                        documentId: state.id,
                        version: state.version - events.length + i + 1,
                        at: ctx.now,
                        event,
                    })),
                });
            };
            return work({ tx, ctx, save });
        });

    /** Load, build the command, execute, save. */
    const run = (id: string, make: (ctx: Context, before: DocumentState | undefined, tx: Transaction) => Command | Promise<Command>) =>
        command(async ({ tx, ctx, save }) => {
            const before = await tx.load(id);
            const { state, events } = execute(before, await make(ctx, before, tx), ctx);
            await save(before, state, events);
            if (!state) throw new InvoiceError("not-found", "id", `no document ${id}`);
            return state;
        });

    return {
        configure: (settings) =>
            store.transaction(async (tx) => {
                await tx.saveSettings({ ...(await tx.settings()), ...checkSettings(settings, registry) });
            }),
        create: (document) => {
            const id = document?.id === undefined ? newId() : idOf(document.id, "id");
            return run(id, (ctx) => ({ type: "create", id, data: expand(document, ctx) }));
        },
        update: (id, document) => run(idOf(id), (ctx) => ({ type: "update", data: expand(document, ctx) })),
        discard: (id) => run(idOf(id), () => ({ type: "discard" })),
        issue: (id) =>
            run(idOf(id), async (ctx, before, tx) => {
                const plan = before?.status === "draft" ? numberingFor(before.data, ctx) : undefined;
                return { type: "issue", number: plan ? plan.format(await tx.next(plan.series)) : "" };
            }),
        void: (id, reason) => run(idOf(id), () => ({ type: "void", reason: parse(string(), reason, "reason") })),
        settle: (id, settlement) => run(idOf(id), () => ({ type: "settle", settlement: parse(S.NewSettlement, settlement, "settlement") })),
        reverseSettlement: (id, settlementId, reason) =>
            run(idOf(id), () => ({ type: "reverse-settlement", settlementId: parse(text(), settlementId, "settlementId"), reason: parse(string(), reason, "reason") })),
        requestDelivery: (id, delivery) => run(idOf(id), () => ({ type: "request-delivery", delivery: parse(S.DeliveryRequest, delivery, "delivery") })),
        completeDelivery: (id, deliveryId, status, detail) =>
            run(idOf(id), () => ({
                type: "complete-delivery",
                deliveryId: parse(text(), deliveryId, "deliveryId"),
                status: parse(S.DeliveryStatus, status, "status"),
                ...(detail !== undefined && { detail: parse(string(), detail, "detail") }),
            })),
        credit: (invoiceId, note) =>
            command(async ({ tx, ctx, save }) => {
                const noteId = parse(text(), note?.id, "note.id");
                const [invoice, existing] = await Promise.all([tx.load(idOf(invoiceId, "invoiceId")), tx.load(noteId)]);
                const plan = invoice?.status === "issued" && !existing ? numberingFor(creditNoteData(invoice, note.input, ctx), ctx) : undefined;
                const number = plan ? plan.format(await tx.next(plan.series)) : "";
                const result = creditInvoice(invoice, existing, { id: noteId, input: note.input, number }, ctx);
                await save(invoice, result.invoice.state, result.invoice.events);
                await save(existing, result.note.state, result.note.events);
                return { invoice: result.invoice.state, note: result.note.state };
            }),
        get: (id) => store.read((tx) => tx.load(idOf(id))),
        getByNumber: (number) =>
            store.read(async (tx) => {
                const id = await tx.holder(parse(text(), number, "number"));
                return id === undefined ? undefined : tx.load(id);
            }),
        list: (query) =>
            store.read(async (tx) => {
                // Only "overdue" without a date needs the tenant's clock, and so its settings.
                const today = query?.status === "overdue" && query.asOf === undefined ? await contextOf(tx) : { now: clock(), timeZone: "UTC" };
                const asked = listFilter(query, today);
                const filter = { ...asked, limit: most(asked.limit) };
                const page = await collect(tx.scan(filter), filter, store.maxScan);
                const documents = await Promise.all(
                    page.rows.map(async (row) => {
                        const doc = await tx.load(row.id);
                        if (!doc) throw new Error(`listing ${row.id} has no document`);
                        return doc;
                    }),
                );
                return { documents, ...(page.next !== undefined && { next: page.next }) };
            }),
        events: (after = 0, limit = 100) =>
            store.read((tx) => tx.events(parse(integer({ min: 0 }), after, "after"), most(parse(integer({ min: 1, max: MAX_PAGE }), limit, "limit")))),
        rebuildListings: (cursor) =>
            store.transaction(async (tx) => {
                const after = cursor === undefined ? undefined : parse(text(), cursor, "cursor");
                const size = most(REBUILD_PAGE);
                const docs = await tx.documents(after, size);
                await Promise.all(docs.map((doc) => tx.relist(doc.id, listingOf(doc))));
                return docs.length === size ? { next: docs.at(-1)!.id } : {};
            }),
    };
}

type Save = (before: DocumentState | undefined, state: DocumentState | undefined, events: DocumentEvent[]) => Promise<void>;

function idOf(id: unknown, path = "id"): string {
    return parse(text(), id, path);
}
