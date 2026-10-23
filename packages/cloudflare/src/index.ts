/**
 * Invoicing on Cloudflare: one Durable Object per tenant, holding that
 * tenant's documents, number sequences and event log in its own SQLite
 * database.
 *
 * A Durable Object runs one request at a time and `transactionSync` makes a
 * command atomic, so every command is: load → allocate a number → execute →
 * save, with no locks and no retries. A refused command rolls back and
 * consumes no number.
 *
 *   export { InvoicingBooks } from "@invoice-primitives/cloudflare";
 *   const books = booksFor(env.INVOICING, tenantId);
 *   await books.issue("inv_123");
 */
import { DurableObject } from "cloudflare:workers";
import {
    bundledPacks,
    checkPage,
    checkSettings,
    contextFor,
    createRegistry,
    expand,
    newId,
    creditInvoice,
    creditNoteData,
    execute,
    InvoiceError,
    numberingFor,
    type Books,
    type Command,
    type Context,
    type CreditNoteInput,
    type DocumentEvent,
    type DocumentState,
    type NewDocument,
    type InvoiceErrorCode,
    type Settings,
    type Settlement,
    type StoredEvent,
} from "@invoice-primitives/core";

const registry = createRegistry(bundledPacks);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    number TEXT UNIQUE,
    version INTEGER NOT NULL,
    state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    position INTEGER PRIMARY KEY,
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

export class InvoicingBooks extends DurableObject<unknown> {
    constructor(ctx: DurableObjectState, env: unknown) {
        super(ctx, env);
        ctx.storage.sql.exec(SCHEMA);
    }

    /**
     * The tenant's settings. `timeZone` (IANA) dates documents by the seller's
     * calendar, defaulting to UTC; `numbering` defaults to INV-{yyyy}-00001.
     */
    configure(settings: Settings): Outcome<null> {
        return this.transaction(() => {
            checkSettings(settings, registry);
            const next = { ...this.settings(), ...Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined)) };
            this.ctx.storage.sql.exec(
                "INSERT INTO settings (key, value) VALUES ('tenant', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                JSON.stringify(next),
            );
            return null;
        });
    }

    private settings(): Settings {
        const row = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM settings WHERE key = 'tenant'").toArray()[0];
        return row ? (JSON.parse(row.value) as Settings) : {};
    }

    create(document: NewDocument) {
        const id = document.id ?? newId();
        return this.run(id, (ctx) => ({ type: "create", id, data: expand(document, ctx) }));
    }
    update(id: string, document: NewDocument) {
        return this.run(id, (ctx) => ({ type: "update", data: expand(document, ctx) }));
    }
    discard(id: string) {
        return this.run(id, { type: "discard" });
    }
    void(id: string, reason: string) {
        return this.run(id, { type: "void", reason });
    }
    settle(id: string, settlement: Omit<Settlement, "reversed">) {
        return this.run(id, { type: "settle", settlement });
    }
    reverseSettlement(id: string, settlementId: string, reason: string) {
        return this.run(id, { type: "reverse-settlement", settlementId, reason });
    }
    requestDelivery(id: string, delivery: { id: string; channel: string; to: string }) {
        return this.run(id, { type: "request-delivery", delivery });
    }
    completeDelivery(id: string, deliveryId: string, status: "delivered" | "failed", detail?: string) {
        return this.run(id, { type: "complete-delivery", deliveryId, status, ...(detail !== undefined && { detail }) });
    }

    issue(id: string): Outcome<DocumentState> {
        return this.transaction((ctx) => {
            const before = this.load(id);
            const plan = before?.status === "draft" ? numberingFor(before.data, ctx) : undefined;
            const { state, events } = execute(before, { type: "issue", number: plan ? plan.format(this.next(plan.series)) : "" }, ctx);
            this.save(ctx, before, state, events);
            return state!;
        });
    }

    credit(invoiceId: string, note: { id: string; input: CreditNoteInput }): Outcome<{ invoice: DocumentState; note: DocumentState }> {
        return this.transaction((ctx) => {
            const invoice = this.load(invoiceId);
            const existing = this.load(note.id);
            const plan = invoice?.status === "issued" && !existing ? numberingFor(creditNoteData(invoice, note.input, ctx), ctx) : undefined;
            const result = creditInvoice(invoice, existing, { ...note, number: plan ? plan.format(this.next(plan.series)) : "" }, ctx);
            this.save(ctx, invoice, result.invoice.state, result.invoice.events);
            this.save(ctx, existing, result.note.state, result.note.events);
            return { invoice: result.invoice.state, note: result.note.state };
        });
    }

    get(id: string): DocumentState | undefined {
        return this.load(id);
    }

    events(after?: number, limit?: number): Outcome<StoredEvent[]> {
        return this.transaction(() => {
            const page = checkPage(after, limit);
            return this.ctx.storage.sql
                .exec<{ position: number; document_id: string; version: number; at: string; event: string }>(
                    "SELECT * FROM events WHERE position > ? ORDER BY position LIMIT ?",
                    page.after,
                    page.limit,
                )
                .toArray()
                .map((r) => ({ position: r.position, documentId: r.document_id, version: r.version, at: r.at, event: JSON.parse(r.event) as DocumentEvent }));
        });
    }

    private run(id: string, command: Command | ((ctx: Context) => Command)): Outcome<DocumentState> {
        return this.transaction((ctx) => {
            const before = this.load(id);
            const { state, events } = execute(before, typeof command === "function" ? command(ctx) : command, ctx);
            this.save(ctx, before, state, events);
            if (!state) throw new InvoiceError("not-found", "id", `no document ${id}`);
            return state;
        });
    }

    /**
     * Atomic: a throw rolls back every write. A refusal comes back as a value,
     * because an exception thrown across RPC is logged as a crash.
     */
    private transaction<T>(fn: (ctx: Context) => T): Outcome<T> {
        const ctx = contextFor(this.settings(), registry, new Date().toISOString());
        try {
            return { ok: true, value: this.ctx.storage.transactionSync(() => fn(ctx)) };
        } catch (e) {
            if (e instanceof InvoiceError) return { ok: false, error: { code: e.code, path: e.path, detail: e.detail } };
            throw e;
        }
    }

    private load(id: string): DocumentState | undefined {
        const row = this.ctx.storage.sql.exec<{ state: string }>("SELECT state FROM documents WHERE id = ?", id).toArray()[0];
        return row ? (JSON.parse(row.state) as DocumentState) : undefined;
    }

    private next(series: string): number {
        return this.ctx.storage.sql
            .exec<{ last: number }>(
                "INSERT INTO sequences (series, last) VALUES (?, 1) ON CONFLICT (series) DO UPDATE SET last = last + 1 RETURNING last",
                series,
            )
            .one().last;
    }

    private save(ctx: Context, before: DocumentState | undefined, state: DocumentState | undefined, events: DocumentEvent[]): void {
        if (!state || events.length === 0) return;
        const sql = this.ctx.storage.sql;
        const number = "number" in state ? state.number : null;
        if (number !== null && sql.exec("SELECT 1 FROM documents WHERE number = ? AND id != ?", number, state.id).toArray().length) {
            throw new InvoiceError("duplicate-number", "number", `number ${number} is taken`);
        }
        if (before) {
            sql.exec(
                "UPDATE documents SET status = ?, number = ?, version = ?, state = ? WHERE id = ? AND version = ?",
                state.status, number, state.version, JSON.stringify(state), state.id, before.version,
            );
        } else {
            sql.exec("INSERT INTO documents (id, status, number, version, state) VALUES (?, ?, ?, ?, ?)", state.id, state.status, number, state.version, JSON.stringify(state));
        }
        if (sql.exec<{ n: number }>("SELECT changes() AS n").one().n !== 1) throw new Error(`document ${state.id} changed during the transaction`);
        let position = sql.exec<{ head: number }>("SELECT COALESCE(MAX(position), 0) AS head FROM events").one().head;
        events.forEach((event, i) =>
            sql.exec(
                "INSERT INTO events (position, document_id, version, at, event) VALUES (?, ?, ?, ?, ?)",
                ++position,
                state.id,
                state.version - events.length + i + 1,
                ctx.now,
                JSON.stringify(event),
            ),
        );
    }
}

/** A command's result across RPC: the value, or the refusal as data. */
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: { code: InvoiceErrorCode; path: string; detail: string } };

/**
 * A tenant's books, from a Worker. Same interface as every other backend;
 * refusals arrive as `InvoiceError` with their code and path.
 */
export function booksFor(namespace: DurableObjectNamespace<InvoicingBooks>, tenant: string): Books {
    const stub = namespace.getByName(tenant);
    const call = async <T>(outcome: Promise<Outcome<T>>): Promise<T> => {
        const o = await outcome;
        if (o.ok) return o.value;
        throw new InvoiceError(o.error.code, o.error.path, o.error.detail);
    };
    return {
        configure: async (settings) => {
            await call(stub.configure(settings));
        },
        create: (document) => call(stub.create(document)),
        update: (id, document) => call(stub.update(id, document)),
        discard: (id) => call(stub.discard(id)),
        issue: (id) => call(stub.issue(id)),
        void: (id, reason) => call(stub.void(id, reason)),
        settle: (id, settlement) => call(stub.settle(id, settlement)),
        reverseSettlement: (id, settlementId, reason) => call(stub.reverseSettlement(id, settlementId, reason)),
        requestDelivery: (id, delivery) => call(stub.requestDelivery(id, delivery)),
        completeDelivery: (id, deliveryId, status, detail) => call(stub.completeDelivery(id, deliveryId, status, detail)),
        credit: (invoiceId, note) => call(stub.credit(invoiceId, note)),
        get: async (id) => stub.get(id),
        events: (after, limit) => call(stub.events(after, limit)),
    };
}
