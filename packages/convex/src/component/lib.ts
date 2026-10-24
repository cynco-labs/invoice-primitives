/**
 * The component's API: core's `Books`, one Convex function per method, on a
 * `Store` over this component's tables. Core runs every rule; this file only
 * reads and writes rows.
 *
 * A Convex mutation is the transaction. Anything thrown (a refused command
 * included) rolls back every write the mutation made, so a refused issue
 * consumes no number and leaves no hole in the log. Two mutations that read
 * the same sequence or log head conflict under OCC, and Convex reruns the
 * loser against the winner's writes, so numbers and log positions are unique
 * and gapless.
 */
import { InvoiceError, type Books, type Refusal } from "@invoice-primitives/core";
import { createBooks, sameListing, type ListFilter, type Listing, type Reader, type Store, type Transaction } from "@invoice-primitives/core/backend";
import type { GenericDatabaseWriter, IndexRange } from "convex/server";
import { ConvexError, v, type Infer } from "convex/values";
import type { DataModel, Id } from "./_generated/dataModel.ts";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.ts";
import {
    asValue,
    vCountryPack,
    vCreditNoteInput,
    vDeliveryRequest,
    vDeliveryStatus,
    vDocumentState,
    vListPage,
    vListQuery,
    vNewDocument,
    vNewSettlement,
    vSettings,
    vStoredEvent,
} from "./validators.ts";

export type { Refusal } from "@invoice-primitives/core";

/** Rethrows core's refusals as `ConvexError`s, whose data survives the trip to the app and to its clients. */
async function refusals<T>(fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (e) {
        if (e instanceof InvoiceError) throw new ConvexError<Refusal>(e.toJSON());
        throw e;
    }
}

/** Listings a page may read, when the filter is narrower than the index it reads. */
const MAX_SCAN = 2000;

/**
 * Documents or events one function loads: at core's MAX_DOCUMENT_BYTES each,
 * 16 stay within a function's read budget whatever the documents weigh.
 */
const MAX_DOCUMENTS = 16;

/** The listings index that narrows `f` most, newest first. */
function scan(ctx: QueryCtx, tenant: string, f: ListFilter) {
    const below = <R extends IndexRange & { lt(field: "seq", value: number): IndexRange }>(range: R): IndexRange =>
        f.before === undefined ? range : range.lt("seq", f.before);
    const listings = ctx.db.query("listings");
    if (f.customer !== undefined) {
        const customer = f.customer;
        return listings.withIndex("by_tenant_and_customer_and_seq", (q) => below(q.eq("tenant", tenant).eq("customer", customer))).order("desc");
    }
    if (f.stage.op === "=") {
        const stage = f.stage.value;
        return listings.withIndex("by_tenant_and_stage_and_seq", (q) => below(q.eq("tenant", tenant).eq("stage", stage))).order("desc");
    }
    if (f.kind !== undefined) {
        const kind = f.kind;
        return listings.withIndex("by_tenant_and_kind_and_seq", (q) => below(q.eq("tenant", tenant).eq("kind", kind))).order("desc");
    }
    return listings.withIndex("by_tenant_and_seq", (q) => below(q.eq("tenant", tenant))).order("desc");
}

/**
 * One tenant's store over a function's `ctx`. A query's store reads; a
 * mutation's also writes, inside the mutation's own transaction.
 */
function store(ctx: QueryCtx | MutationCtx, tenant: string): Store {
    if (!tenant) throw new InvoiceError("invalid-argument", "tenant", "a tenant is a non-empty string");
    /** Each document row a command loaded or wrote, so a save need not read it again. */
    const rows = new Map<string, { _id: Id<"documents">; version: number } | null>();
    const documentRow = async (id: string) => {
        const cached = rows.get(id);
        if (cached === null) return undefined;
        const row = cached
            ? await ctx.db.get("documents", cached._id)
            : await ctx.db
                  .query("documents")
                  .withIndex("by_tenant_and_documentId", (q) => q.eq("tenant", tenant).eq("documentId", id))
                  .unique();
        rows.set(id, row && { _id: row._id, version: row.state.version });
        return row?.state;
    };
    const settingsRow = () => ctx.db.query("settings").withIndex("by_tenant", (q) => q.eq("tenant", tenant)).unique();

    const read: Reader = {
        async settings() {
            const row = await settingsRow();
            if (!row) return {};
            const { _id, _creationTime, tenant: _tenant, ...settings } = row;
            return settings;
        },
        load: documentRow,
        async *scan(filter) {
            for await (const { documentId, seq, kind, stage, customer, dueDate } of scan(ctx, tenant, filter)) {
                yield { id: documentId, seq, kind, stage, ...(customer !== undefined && { customer }), ...(dueDate !== undefined && { dueDate }) };
            }
        },
        async events(after, limit) {
            const events = await ctx.db
                .query("events")
                .withIndex("by_tenant_and_position", (q) => q.eq("tenant", tenant).gt("position", after))
                .take(limit);
            // Events written before formats existed are format 1.
            return events.map(({ position, format = 1, documentId, version, at, event }) => ({ position, format, documentId, version, at, event }));
        },
        async holder(number) {
            const row = await ctx.db
                .query("documents")
                .withIndex("by_tenant_and_number", (q) => q.eq("tenant", tenant).eq("number", number))
                .first();
            return row?.documentId;
        },
        async documents(after, limit) {
            const documents = await ctx.db
                .query("documents")
                .withIndex("by_tenant_and_documentId", (q) => (after === undefined ? q.eq("tenant", tenant) : q.eq("tenant", tenant).gt("documentId", after)))
                .take(limit);
            return documents.map((r) => r.state);
        },
    };

    const writer = "insert" in ctx.db ? ctx.db : undefined;
    return {
        read: (work) => work(read),
        transaction: (work) => (writer ? work(transaction(writer)) : Promise.reject(new Error("a query cannot write"))),
        maxScan: MAX_SCAN,
        maxDocuments: MAX_DOCUMENTS,
    };

    function transaction(db: GenericDatabaseWriter<DataModel>): Transaction {
        const relist = async (id: string, listing: Listing) => {
            const row = await db
                .query("listings")
                .withIndex("by_tenant_and_documentId", (q) => q.eq("tenant", tenant).eq("documentId", id))
                .unique();
            if (row) {
                // An unchanged listing is left alone, so a rebuild invalidates no subscription it need not.
                if (!sameListing(row, listing)) await db.replace("listings", row._id, { tenant, documentId: id, ...listing, seq: row.seq });
                return;
            }
            // A document saved before listings existed: its seq is its first event's position.
            const first = await db
                .query("events")
                .withIndex("by_tenant_and_documentId_and_position", (q) => q.eq("tenant", tenant).eq("documentId", id))
                .first();
            if (!first) throw new Error(`document ${id} has no events`);
            await db.insert("listings", { tenant, documentId: id, ...listing, seq: first.position });
        };
        return {
            ...read,
            async saveSettings(settings) {
                const row = await settingsRow();
                const next = { tenant, ...asValue.settings(settings) };
                if (row) await db.replace("settings", row._id, next);
                else await db.insert("settings", next);
            },
            async next(series) {
                const row = await db
                    .query("sequences")
                    .withIndex("by_tenant_and_series", (q) => q.eq("tenant", tenant).eq("series", series))
                    .unique();
                const last = (row?.last ?? 0) + 1;
                if (row) await db.patch("sequences", row._id, { last });
                else await db.insert("sequences", { tenant, series, last });
                return last;
            },
            async head() {
                const last = await db
                    .query("events")
                    .withIndex("by_tenant_and_position", (q) => q.eq("tenant", tenant))
                    .order("desc")
                    .first();
                return last?.position ?? 0;
            },
            async write({ state, expected, listing, events }) {
                if (!rows.has(state.id)) await documentRow(state.id);
                const row = rows.get(state.id);
                if (row?.version !== expected) throw new Error(`document ${state.id} changed during the transaction`);
                const next = { tenant, documentId: state.id, state: asValue.state(state), ...("number" in state && { number: state.number }) };
                if (row) {
                    await db.replace("documents", row._id, next);
                    await relist(state.id, listing);
                } else {
                    // A new document has no listing yet: its seq is its first event's position.
                    rows.set(state.id, { _id: await db.insert("documents", next), version: state.version });
                    await db.insert("listings", { tenant, documentId: state.id, ...listing, seq: events[0]!.position });
                }
                rows.set(state.id, { ...rows.get(state.id)!, version: state.version });
                for (const e of events) await db.insert("events", { tenant, ...asValue.stored(e) });
            },
            relist,
        };
    }
}

const vPacks = v.optional(v.array(vCountryPack));
const scope = { tenant: v.string(), packs: vPacks };

function books(ctx: QueryCtx | MutationCtx, a: { tenant: string; packs?: Infer<typeof vPacks> }): Books {
    return createBooks(store(ctx, a.tenant), { packs: a.packs });
}

/** Replaces the given settings, keeping the others. */
export const configure = mutation({
    args: { ...scope, settings: vSettings },
    returns: v.null(),
    handler: (ctx, a) =>
        refusals(async () => {
            await books(ctx, a).configure(a.settings);
            return null;
        }),
});

/** A new draft from a short document; its id is generated when absent. */
export const create = mutation({
    args: { ...scope, document: vNewDocument },
    returns: vDocumentState,
    handler: (ctx, a) => refusals(async () => asValue.state(await books(ctx, a).create(a.document))),
});

export const update = mutation({
    args: { ...scope, id: v.string(), document: vNewDocument },
    returns: vDocumentState,
    handler: (ctx, a) => refusals(async () => asValue.state(await books(ctx, a).update(a.id, a.document))),
});

export const discard = mutation({
    args: { ...scope, id: v.string() },
    returns: vDocumentState,
    handler: (ctx, a) => refusals(async () => asValue.state(await books(ctx, a).discard(a.id))),
});

/** Takes the next number in the document's series in the same transaction as the issue. */
export const issue = mutation({
    args: { ...scope, id: v.string() },
    returns: vDocumentState,
    handler: (ctx, a) => refusals(async () => asValue.state(await books(ctx, a).issue(a.id))),
});

export const voidDocument = mutation({
    args: { ...scope, id: v.string(), reason: v.string() },
    returns: vDocumentState,
    handler: (ctx, a) => refusals(async () => asValue.state(await books(ctx, a).void(a.id, a.reason))),
});

export const settle = mutation({
    args: { ...scope, id: v.string(), settlement: vNewSettlement },
    returns: vDocumentState,
    handler: (ctx, a) => refusals(async () => asValue.state(await books(ctx, a).settle(a.id, a.settlement))),
});

export const reverseSettlement = mutation({
    args: { ...scope, id: v.string(), settlementId: v.string(), reason: v.string() },
    returns: vDocumentState,
    handler: (ctx, a) => refusals(async () => asValue.state(await books(ctx, a).reverseSettlement(a.id, a.settlementId, a.reason))),
});

export const requestDelivery = mutation({
    args: { ...scope, id: v.string(), delivery: vDeliveryRequest },
    returns: vDocumentState,
    handler: (ctx, a) => refusals(async () => asValue.state(await books(ctx, a).requestDelivery(a.id, a.delivery))),
});

export const completeDelivery = mutation({
    args: { ...scope, id: v.string(), deliveryId: v.string(), status: vDeliveryStatus, detail: v.optional(v.string()) },
    returns: vDocumentState,
    handler: (ctx, a) => refusals(async () => asValue.state(await books(ctx, a).completeDelivery(a.id, a.deliveryId, a.status, a.detail))),
});

/** Issues a credit note against an issued invoice and applies it to both, numbered in the note's series. */
export const credit = mutation({
    args: { ...scope, invoiceId: v.string(), note: v.object({ id: v.string(), input: vCreditNoteInput }) },
    returns: v.object({ invoice: vDocumentState, note: vDocumentState }),
    handler: (ctx, a) =>
        refusals(async () => {
            const { invoice, note } = await books(ctx, a).credit(a.invoiceId, a.note);
            return { invoice: asValue.state(invoice), note: asValue.state(note) };
        }),
});

/** Rewrites a page of listings from their documents; call again with `next` until it is absent. */
export const rebuildListings = mutation({
    args: { ...scope, cursor: v.optional(v.string()) },
    returns: v.object({ next: v.optional(v.string()) }),
    handler: (ctx, a) => refusals(() => books(ctx, a).rebuildListings(a.cursor)),
});

export const get = query({
    args: { tenant: v.string(), id: v.string() },
    returns: v.union(vDocumentState, v.null()),
    handler: (ctx, a) => refusals(async () => asValue.stateOrNull(await books(ctx, a).get(a.id))),
});

export const getByNumber = query({
    args: { tenant: v.string(), number: v.string() },
    returns: v.union(vDocumentState, v.null()),
    handler: (ctx, a) => refusals(async () => asValue.stateOrNull(await books(ctx, a).getByNumber(a.number))),
});

/**
 * The tenant's documents, newest first, filtered by kind, status and customer.
 * A page reads at most MAX_SCAN listings, so it can come back short with a
 * `next`. Without `asOf`, "overdue" is judged on the date the query runs; a
 * cached or subscribed query is not rerun when the date changes, so a reactive
 * caller passes `asOf` itself.
 */
export const list = query({
    args: { ...scope, query: v.optional(vListQuery) },
    returns: vListPage,
    handler: (ctx, a) =>
        refusals(async () => {
            const page = await books(ctx, a).list(a.query);
            return { documents: page.documents.map(asValue.state), ...(page.next !== undefined && { next: page.next }) };
        }),
});

/** The tenant's log after position `after` (default 0), at most `limit` (default 100, at most 1000) events. */
export const events = query({
    args: { tenant: v.string(), after: v.optional(v.number()), limit: v.optional(v.number()) },
    returns: v.array(vStoredEvent),
    handler: (ctx, a) => refusals(async () => (await books(ctx, a).events(a.after, a.limit)).map(asValue.stored)),
});
