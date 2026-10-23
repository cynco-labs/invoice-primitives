/**
 * Invoicing on Cloudflare: one Durable Object per tenant, holding that
 * tenant's documents, number sequences and event log in its own SQLite
 * database. The object is a `Store` for core's `createBooks`, which runs
 * every rule; this file only reads and writes rows.
 *
 * Every SQL statement inside `ctx.storage.transaction` belongs to that
 * transaction, and SQL calls complete synchronously, so no other request runs
 * in the middle of a command. A refused command rolls back and consumes no
 * number.
 *
 *   export { InvoicingBooks } from "@invoice-primitives/cloudflare";
 *   const books = booksFor(env.INVOICING, tenantId);
 *   await books.issue("inv_123");
 */
import { DurableObject } from "cloudflare:workers";
import {
    InvoiceError,
    type Books,
    type BooksOptions,
    type CountryPack,
    type CreditNoteInput,
    type DeliveryRequest,
    type DeliveryStatus,
    type DocumentState,
    type ListPage,
    type ListQuery,
    type NewDocument,
    type NewSettlement,
    type Refusal,
    type Settings,
    type StoredEvent,
} from "@invoice-primitives/core";
import { conditions, createBooks, listingOf, type Listing, type ListingRow, type Reader, type Store, type Transaction } from "@invoice-primitives/core/backend";

const DOCUMENTS = `
CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    number TEXT UNIQUE,
    version INTEGER NOT NULL,
    -- The log position of the document's first event: the order of list.
    seq INTEGER NOT NULL UNIQUE,
    -- Core's Listing, copied out of state on every save.
    kind TEXT NOT NULL,
    stage TEXT NOT NULL,
    customer TEXT,
    due_date TEXT,
    state TEXT NOT NULL
)`;

const SCHEMA = `
${DOCUMENTS};
CREATE INDEX IF NOT EXISTS documents_by_kind ON documents (kind, seq);
CREATE INDEX IF NOT EXISTS documents_by_stage ON documents (stage, seq);
CREATE INDEX IF NOT EXISTS documents_by_customer ON documents (customer, seq);
CREATE TABLE IF NOT EXISTS events (
    position INTEGER PRIMARY KEY,
    format INTEGER NOT NULL,
    document_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    at TEXT NOT NULL,
    event TEXT NOT NULL,
    UNIQUE (document_id, version)
);
CREATE TABLE IF NOT EXISTS sequences (
    series TEXT PRIMARY KEY,
    last INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);`;

/** The `documents` column each listing field is stored in. */
const COLUMNS = { kind: "kind", stage: "stage", customer: "customer", dueDate: "due_date" } as const satisfies Record<keyof Listing, string>;

type EventRow = { position: number; format: number; document_id: string; version: number; at: string; event: string };

export class InvoicingBooks extends DurableObject<unknown> {
    readonly #store: Store;

    constructor(ctx: DurableObjectState, env: unknown) {
        super(ctx, env);
        ctx.storage.transactionSync(() => {
            this.#migrate();
            ctx.storage.sql.exec(SCHEMA);
        });
        this.#store = this.#makeStore();
    }

    #books(packs: Packs): Books {
        return createBooks(this.#store, { packs });
    }

    configure(settings: Settings, packs?: Packs) {
        return outcome(() => this.#books(packs).configure(settings));
    }
    create(document: NewDocument, packs?: Packs) {
        return outcome(() => this.#books(packs).create(document));
    }
    update(id: string, document: NewDocument, packs?: Packs) {
        return outcome(() => this.#books(packs).update(id, document));
    }
    discard(id: string, packs?: Packs) {
        return outcome(() => this.#books(packs).discard(id));
    }
    issue(id: string, packs?: Packs) {
        return outcome(() => this.#books(packs).issue(id));
    }
    void(id: string, reason: string, packs?: Packs) {
        return outcome(() => this.#books(packs).void(id, reason));
    }
    settle(id: string, settlement: NewSettlement, packs?: Packs) {
        return outcome(() => this.#books(packs).settle(id, settlement));
    }
    reverseSettlement(id: string, settlementId: string, reason: string, packs?: Packs) {
        return outcome(() => this.#books(packs).reverseSettlement(id, settlementId, reason));
    }
    requestDelivery(id: string, delivery: DeliveryRequest, packs?: Packs) {
        return outcome(() => this.#books(packs).requestDelivery(id, delivery));
    }
    completeDelivery(id: string, deliveryId: string, status: DeliveryStatus, detail?: string, packs?: Packs) {
        return outcome(() => this.#books(packs).completeDelivery(id, deliveryId, status, detail));
    }
    credit(invoiceId: string, note: { id: string; input: CreditNoteInput }, packs?: Packs) {
        return outcome(() => this.#books(packs).credit(invoiceId, note));
    }
    get(id: string) {
        return outcome(() => this.#books(undefined).get(id));
    }
    getByNumber(number: string) {
        return outcome(() => this.#books(undefined).getByNumber(number));
    }
    list(query?: ListQuery, packs?: Packs): Promise<Outcome<ListPage>> {
        return outcome(() => this.#books(packs).list(query));
    }
    events(after?: number, limit?: number): Promise<Outcome<StoredEvent[]>> {
        return outcome(() => this.#books(undefined).events(after, limit));
    }
    rebuildListings(cursor?: string, packs?: Packs) {
        return outcome(() => this.#books(packs).rebuildListings(cursor));
    }

    #makeStore(): Store {
        const sql = this.ctx.storage.sql;
        const reader: Reader = {
            settings: async () => {
                const row = sql.exec<{ value: string }>("SELECT value FROM settings WHERE key = 'tenant'").toArray()[0];
                return row ? (JSON.parse(row.value) as Settings) : {};
            },
            load: async (id) => {
                const row = sql.exec<{ state: string }>("SELECT state FROM documents WHERE id = ?", id).toArray()[0];
                return row ? (JSON.parse(row.state) as DocumentState) : undefined;
            },
            *scan(filter) {
                const where: string[] = [];
                const params: (string | number)[] = [];
                for (const c of conditions(filter)) {
                    where.push(`${COLUMNS[c.field]} ${c.op} ?`);
                    params.push(c.value);
                }
                if (filter.before !== undefined) {
                    where.push("seq < ?");
                    params.push(filter.before);
                }
                type Row = { id: string; seq: number; kind: ListingRow["kind"]; stage: ListingRow["stage"]; customer: string | null; due_date: string | null };
                const rows = sql.exec<Row>(`SELECT id, seq, kind, stage, customer, due_date FROM documents WHERE ${where.join(" AND ")} ORDER BY seq DESC`, ...params);
                for (const r of rows) {
                    yield { id: r.id, seq: r.seq, kind: r.kind, stage: r.stage, ...(r.customer !== null && { customer: r.customer }), ...(r.due_date !== null && { dueDate: r.due_date }) };
                }
            },
            events: async (after, limit) =>
                sql
                    .exec<EventRow>("SELECT * FROM events WHERE position > ? ORDER BY position LIMIT ?", after, limit)
                    .toArray()
                    .map((r) => ({ position: r.position, format: r.format, documentId: r.document_id, version: r.version, at: r.at, event: JSON.parse(r.event) as StoredEvent["event"] })),
            holder: async (number) => sql.exec<{ id: string }>("SELECT id FROM documents WHERE number = ?", number).toArray()[0]?.id,
            documents: async (after, limit) =>
                sql
                    .exec<{ state: string }>("SELECT state FROM documents WHERE id > ? ORDER BY id LIMIT ?", after ?? "", limit)
                    .toArray()
                    .map((r) => JSON.parse(r.state) as DocumentState),
        };
        const tx: Transaction = {
            ...reader,
            saveSettings: async (settings) => {
                sql.exec("INSERT INTO settings (key, value) VALUES ('tenant', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", JSON.stringify(settings));
            },
            next: async (series) =>
                sql.exec<{ last: number }>("INSERT INTO sequences (series, last) VALUES (?, 1) ON CONFLICT (series) DO UPDATE SET last = last + 1 RETURNING last", series).one().last,
            head: async () => sql.exec<{ head: number }>("SELECT COALESCE(MAX(position), 0) AS head FROM events").one().head,
            write: async ({ state, expected, listing, events }) => {
                // A new document's seq is its first event's position.
                if (expected === undefined) this.#insert(state, listing, events[0]!.position);
                else {
                    sql.exec(
                        "UPDATE documents SET number = ?, version = ?, kind = ?, stage = ?, customer = ?, due_date = ?, state = ? WHERE id = ? AND version = ?",
                        "number" in state ? state.number : null, state.version, ...columns(listing), JSON.stringify(state), state.id, expected,
                    );
                    if (sql.exec<{ n: number }>("SELECT changes() AS n").one().n !== 1) throw new Error(`document ${state.id} changed during the transaction`);
                }
                for (const e of events) {
                    sql.exec(
                        "INSERT INTO events (position, format, document_id, version, at, event) VALUES (?, ?, ?, ?, ?, ?)",
                        e.position, e.format, e.documentId, e.version, e.at, JSON.stringify(e.event),
                    );
                }
            },
            relist: async (id, listing) => {
                sql.exec(
                    "UPDATE documents SET kind = ?, stage = ?, customer = ?, due_date = ? WHERE id = ? AND NOT (kind IS ? AND stage IS ? AND customer IS ? AND due_date IS ?)",
                    ...columns(listing), id, ...columns(listing),
                );
            },
        };
        return {
            transaction: (work) => this.ctx.storage.transaction(() => work(tx)),
            read: (work) => work(reader),
        };
    }

    #insert(state: DocumentState, listing: Listing, seq: number, table = "documents"): void {
        this.ctx.storage.sql.exec(
            `INSERT INTO ${table} (id, number, version, seq, kind, stage, customer, due_date, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            state.id, "number" in state ? state.number : null, state.version, seq, ...columns(listing), JSON.stringify(state),
        );
    }

    /** Brings tables written by an earlier version of this package up to the current schema. */
    #migrate(): void {
        const sql = this.ctx.storage.sql;
        const columns = (table: string) => sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).toArray().map((c) => c.name);
        const events = columns("events");
        if (events.length > 0 && !events.includes("format")) sql.exec("ALTER TABLE events ADD COLUMN format INTEGER NOT NULL DEFAULT 1");
        const documents = columns("documents");
        if (documents.length === 0 || documents.includes("seq")) return;
        // Before listings: rebuild the table, deriving each listing from its state and its seq from the log.
        sql.exec(DOCUMENTS.replace("documents", "documents_listed"));
        for (const row of sql.exec<{ id: string; state: string }>("SELECT id, state FROM documents").toArray()) {
            try {
                const state = JSON.parse(row.state) as DocumentState;
                const { seq } = sql.exec<{ seq: number | null }>("SELECT MIN(position) AS seq FROM events WHERE document_id = ?", state.id).one();
                if (seq === null) throw new Error("it has no events");
                this.#insert(state, listingOf(state), seq, "documents_listed");
            } catch (e) {
                throw new Error(`cannot migrate document ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        sql.exec("DROP TABLE documents");
        sql.exec("ALTER TABLE documents_listed RENAME TO documents");
    }
}

/** A listing's values in the column order kind, stage, customer, due_date. */
function columns({ kind, stage, customer, dueDate }: Listing): [string, string, string | null, string | null] {
    return [kind, stage, customer ?? null, dueDate ?? null];
}

type Packs = readonly CountryPack[] | undefined;

/** A command's result across RPC: the value, or the refusal as data. */
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: Refusal };

/** A refusal comes back as a value, because an exception thrown across RPC is logged as a crash. */
async function outcome<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
    try {
        return { ok: true, value: await fn() };
    } catch (e) {
        if (e instanceof InvoiceError) return { ok: false, error: e.toJSON() };
        throw e;
    }
}

/** The packs, as data, sent with each call. */
export type BooksForOptions = Pick<BooksOptions, "packs">;

/**
 * A tenant's books, from a Worker. Same interface as every other backend;
 * refusals arrive as `InvoiceError` with their code and path.
 */
export function booksFor(namespace: DurableObjectNamespace<InvoicingBooks>, tenant: string, options: BooksForOptions = {}): Books {
    const stub = namespace.getByName(tenant);
    const { packs } = options;
    const call = async <T>(result: Promise<Outcome<T>>): Promise<T> => {
        const o = await result;
        if (o.ok) return o.value;
        throw InvoiceError.from(o.error)!;
    };
    return {
        configure: (settings) => call(stub.configure(settings, packs)),
        create: (document) => call(stub.create(document, packs)),
        update: (id, document) => call(stub.update(id, document, packs)),
        discard: (id) => call(stub.discard(id, packs)),
        issue: (id) => call(stub.issue(id, packs)),
        void: (id, reason) => call(stub.void(id, reason, packs)),
        settle: (id, settlement) => call(stub.settle(id, settlement, packs)),
        reverseSettlement: (id, settlementId, reason) => call(stub.reverseSettlement(id, settlementId, reason, packs)),
        requestDelivery: (id, delivery) => call(stub.requestDelivery(id, delivery, packs)),
        completeDelivery: (id, deliveryId, status, detail) => call(stub.completeDelivery(id, deliveryId, status, detail, packs)),
        credit: (invoiceId, note) => call(stub.credit(invoiceId, note, packs)),
        get: (id) => call(stub.get(id)),
        getByNumber: (number) => call(stub.getByNumber(number)),
        list: (query) => call(stub.list(query, packs)),
        events: (after, limit) => call(stub.events(after, limit)),
        rebuildListings: (cursor) => call(stub.rebuildListings(cursor, packs)),
    };
}
