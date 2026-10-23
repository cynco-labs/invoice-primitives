/**
 * The component's API: core's `Books`, one Convex mutation per command.
 *
 * Every mutation follows `memory.ts` from core:
 *
 *   in one transaction: load the state → (allocate a number) → execute → save state and events
 *
 * A Convex mutation is that transaction. Anything thrown (a refused command
 * included) rolls back every write the mutation made, so a refused issue
 * consumes no number and leaves no hole in the log. Two mutations that read
 * the same sequence or log head conflict under OCC, and Convex reruns the
 * loser against the winner's writes, so numbers and log positions are unique
 * and gapless.
 */
import {
    bundledPacks,
    checkPage,
    checkSettings,
    contextFor,
    expand,
    newId,
    createRegistry,
    creditInvoice,
    creditNoteData,
    execute,
    InvoiceError,
    numberingFor,
    type Command,
    type Context,
    type DocumentEvent,
    type DocumentState,
} from "@invoice-primitives/core";
import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel.ts";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.ts";
import {
    vCreditNoteInput,
    vDeliveryRequest,
    vDeliveryStatus,
    vDocumentState,
    vNewDocument,
    vNewSettlement,
    vSettings,
    vStoredEvent,
    asValue,
} from "./validators.ts";

const registry = createRegistry(bundledPacks);


/** What a refusal carries across the component boundary: core's `InvoiceError`, as data. */
export type Refusal = { code: string; path: string; detail: string };

function refuse(code: string, path: string, detail: string): never {
    throw new ConvexError<Refusal>({ code, path, detail });
}

/** Rethrows core's refusals as `ConvexError`s, whose data survives the trip to the app and to its clients. */
async function refusals<T>(fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (e) {
        if (e instanceof InvoiceError) refuse(e.code, e.path, e.detail);
        throw e;
    }
}

function checkTenant(tenant: string): void {
    if (!tenant) refuse("invalid-argument", "tenant", "a tenant is a non-empty string");
}

function load(ctx: QueryCtx, tenant: string, documentId: string): Promise<Doc<"documents"> | null> {
    return ctx.db
        .query("documents")
        .withIndex("by_tenant_and_documentId", (q) => q.eq("tenant", tenant).eq("documentId", documentId))
        .unique();
}

function settingsOf(ctx: QueryCtx, tenant: string): Promise<Doc<"settings"> | null> {
    return ctx.db.query("settings").withIndex("by_tenant", (q) => q.eq("tenant", tenant)).unique();
}

/** A settings row without its system fields: core's `Settings`. */
function settingsFrom({ _id, _creationTime, tenant, ...settings }: Doc<"settings">) {
    return settings;
}

/** One mutation's view of a tenant's books: what `memory.ts` keeps in maps, here read and written through indexes. */
async function books(ctx: MutationCtx, tenant: string) {
    checkTenant(tenant);
    const row = await settingsOf(ctx, tenant);
    // Date is fixed for the whole mutation in Convex, so every event in it shares one instant.
    const context: Context = contextFor(row ? settingsFrom(row) : {}, registry, new Date().toISOString());
    let head: number | undefined;

    /**
     * The next log position. The head is read only when a command produced
     * events, so a retried no-op neither reads nor conflicts on the log.
     */
    const nextPosition = async (): Promise<number> => {
        if (head === undefined) {
            const last = await ctx.db
                .query("events")
                .withIndex("by_tenant_and_position", (q) => q.eq("tenant", tenant))
                .order("desc")
                .first();
            head = last?.position ?? 0;
        }
        head += 1;
        return head;
    };

    return {
        context,
        load: (documentId: string) => load(ctx, tenant, documentId),

        /** Takes the next value of `series`. A refusal later in the mutation rolls this back with the rest. */
        async next(series: string): Promise<number> {
            const row = await ctx.db
                .query("sequences")
                .withIndex("by_tenant_and_series", (q) => q.eq("tenant", tenant).eq("series", series))
                .unique();
            const last = (row?.last ?? 0) + 1;
            if (row) await ctx.db.patch("sequences", row._id, { last });
            else await ctx.db.insert("sequences", { tenant, series, last });
            return last;
        },

        /** Saves the document `row` became, and appends its events to the tenant's log. */
        async save(row: Doc<"documents"> | null, state: DocumentState | undefined, events: DocumentEvent[]): Promise<void> {
            if (!state || events.length === 0) return;
            const fields = {
                tenant,
                documentId: state.id,
                state: asValue.state(state),
                ...((state.status === "issued" || state.status === "void") && { number: state.number }),
            };
            if (fields.number !== undefined && fields.number !== row?.number) {
                const holder = await ctx.db
                    .query("documents")
                    .withIndex("by_tenant_and_number", (q) => q.eq("tenant", tenant).eq("number", fields.number))
                    .first();
                if (holder) throw new InvoiceError("duplicate-number", "number", `number ${fields.number} is taken`);
            }
            if (row) await ctx.db.replace("documents", row._id, fields);
            else await ctx.db.insert("documents", fields);
            for (const [i, event] of events.entries()) {
                await ctx.db.insert("events", {
                    tenant,
                    position: await nextPosition(),
                    documentId: state.id,
                    version: state.version - events.length + i + 1,
                    at: context.now,
                    event: asValue.event(event),
                });
            }
        },
    };
}

const scope = { tenant: v.string() };
type Scope = { tenant: string };

/** Runs a command that needs no number: load → execute → save. */
function run(ctx: MutationCtx, scope: Scope, id: string, command: Command | ((context: Context) => Command)) {
    return refusals(async () => {
        const b = await books(ctx, scope.tenant);
        const row = await b.load(id);
        const { state, events } = execute(row?.state, typeof command === "function" ? command(b.context) : command, b.context);
        await b.save(row, state, events);
        if (!state) throw new InvoiceError("not-found", "id", `no document ${id}`);
        return asValue.state(state);
    });
}

/** Replaces the given settings, keeping the others. */
export const configure = mutation({
    args: { tenant: v.string(), settings: vSettings },
    returns: v.null(),
    handler: (ctx, { tenant, settings }) =>
        refusals(async () => {
            checkTenant(tenant);
            checkSettings(settings, registry);
            const row = await settingsOf(ctx, tenant);
            const next = { tenant, ...(row && settingsFrom(row)), ...settings };
            if (row) await ctx.db.replace("settings", row._id, next);
            else await ctx.db.insert("settings", next);
            return null;
        }),
});

/** A new draft from a short document; its id is generated when absent. */
export const create = mutation({
    args: { ...scope, document: vNewDocument },
    returns: vDocumentState,
    handler: (ctx, a) => {
        const id = a.document.id ?? newId();
        return run(ctx, a, id, (context) => ({ type: "create", id, data: expand(a.document, context) }));
    },
});

export const update = mutation({
    args: { ...scope, id: v.string(), document: vNewDocument },
    returns: vDocumentState,
    handler: (ctx, a) => run(ctx, a, a.id, (context) => ({ type: "update", data: expand(a.document, context) })),
});

export const discard = mutation({
    args: { ...scope, id: v.string() },
    returns: vDocumentState,
    handler: (ctx, a) => run(ctx, a, a.id, { type: "discard" }),
});

/** Takes the next number in the document's series in the same transaction as the issue. */
export const issue = mutation({
    args: { ...scope, id: v.string() },
    returns: vDocumentState,
    handler: (ctx, a) =>
        refusals(async () => {
            const b = await books(ctx, a.tenant);
            const row = await b.load(a.id);
            const plan = row?.state.status === "draft" ? numberingFor(row.state.data, b.context) : undefined;
            const number = plan ? plan.format(await b.next(plan.series)) : "";
            const { state, events } = execute(row?.state, { type: "issue", number }, b.context);
            await b.save(row, state, events);
            if (!state) throw new InvoiceError("not-found", "id", `no document ${a.id}`);
            return asValue.state(state);
        }),
});

export const voidDocument = mutation({
    args: { ...scope, id: v.string(), reason: v.string() },
    returns: vDocumentState,
    handler: (ctx, a) => run(ctx, a, a.id, { type: "void", reason: a.reason }),
});

export const settle = mutation({
    args: { ...scope, id: v.string(), settlement: vNewSettlement },
    returns: vDocumentState,
    handler: (ctx, a) => run(ctx, a, a.id, { type: "settle", settlement: a.settlement }),
});

export const reverseSettlement = mutation({
    args: { ...scope, id: v.string(), settlementId: v.string(), reason: v.string() },
    returns: vDocumentState,
    handler: (ctx, a) => run(ctx, a, a.id, { type: "reverse-settlement", settlementId: a.settlementId, reason: a.reason }),
});

export const requestDelivery = mutation({
    args: { ...scope, id: v.string(), delivery: vDeliveryRequest },
    returns: vDocumentState,
    handler: (ctx, a) => run(ctx, a, a.id, { type: "request-delivery", delivery: a.delivery }),
});

export const completeDelivery = mutation({
    args: { ...scope, id: v.string(), deliveryId: v.string(), status: vDeliveryStatus, detail: v.optional(v.string()) },
    returns: vDocumentState,
    handler: (ctx, a) =>
        run(ctx, a, a.id, {
            type: "complete-delivery",
            deliveryId: a.deliveryId,
            status: a.status,
            ...(a.detail !== undefined && { detail: a.detail }),
        }),
});

/** Issues a credit note against an issued invoice and applies it to both, numbered in the note's series. */
export const credit = mutation({
    args: { ...scope, invoiceId: v.string(), note: v.object({ id: v.string(), input: vCreditNoteInput }) },
    returns: v.object({ invoice: vDocumentState, note: vDocumentState }),
    handler: (ctx, a) =>
        refusals(async () => {
            const b = await books(ctx, a.tenant);
            const invoice = await b.load(a.invoiceId);
            const existing = await b.load(a.note.id);
            const invoiceState = invoice?.state;
            const plan =
                invoiceState?.status === "issued" && !existing
                    ? numberingFor(creditNoteData(invoiceState, a.note.input, b.context), b.context)
                    : undefined;
            const number = plan ? plan.format(await b.next(plan.series)) : "";
            const result = creditInvoice(invoiceState, existing?.state, { ...a.note, number }, b.context);
            await b.save(invoice, result.invoice.state, result.invoice.events);
            await b.save(existing, result.note.state, result.note.events);
            return { invoice: asValue.state(result.invoice.state), note: asValue.state(result.note.state) };
        }),
});

export const get = query({
    args: { tenant: v.string(), id: v.string() },
    returns: v.union(vDocumentState, v.null()),
    handler: async (ctx, a) => (await load(ctx, a.tenant, a.id))?.state ?? null,
});

export const getByNumber = query({
    args: { tenant: v.string(), number: v.string() },
    returns: v.union(vDocumentState, v.null()),
    handler: async (ctx, a) => {
        const row = await ctx.db
            .query("documents")
            .withIndex("by_tenant_and_number", (q) => q.eq("tenant", a.tenant).eq("number", a.number))
            .first();
        return row?.state ?? null;
    },
});

/** The tenant's log after position `after` (default 0), at most `limit` (default 100, at most 1000) events. */
export const events = query({
    args: { tenant: v.string(), after: v.optional(v.number()), limit: v.optional(v.number()) },
    returns: v.array(vStoredEvent),
    handler: (ctx, args) =>
        refusals(async () => {
            const { after, limit } = checkPage(args.after, args.limit);
            const rows = await ctx.db
                .query("events")
                .withIndex("by_tenant_and_position", (q) => q.eq("tenant", args.tenant).gt("position", after))
                .take(limit);
            return rows.map(({ position, documentId, version, at, event }) => ({ position, documentId, version, at, event }));
        }),
});
