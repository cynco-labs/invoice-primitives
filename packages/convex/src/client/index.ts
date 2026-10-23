/**
 * The app-side client: core's `Books` methods, each taking the calling
 * function's `ctx` and the tenant whose books it touches.
 *
 *   const invoicing = new Invoicing(components.invoicing);
 *   await invoicing.books(ctx, tenant).issue("inv_1");
 *
 * Each method runs one component function: one transaction. Through `books`,
 * a refusal is core's `InvoiceError`, as on every backend. The direct methods
 * throw a `ConvexError` whose `data` is the refusal; `refusalOf` reads it.
 */
import { InvoiceError, type Books, type BooksOptions, type CreditNoteInput, type DeliveryRequest, type DeliveryStatus, type DocumentState, type ListPage, type ListQuery, type NewDocument, type NewSettlement, type Settings, type StoredEvent } from "@invoice-primitives/core";
import { parse, shapes } from "@invoice-primitives/core/schema";
import type { GenericDataModel, GenericMutationCtx, GenericQueryCtx } from "convex/server";
import { ConvexError } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.ts";
import { asValue } from "../component/validators.ts";

export type { ComponentApi } from "../component/_generated/component.ts";
export type { Refusal } from "@invoice-primitives/core";

type RunQueryCtx = { runQuery: GenericQueryCtx<GenericDataModel>["runQuery"] };
type RunMutationCtx = { runMutation: GenericMutationCtx<GenericDataModel>["runMutation"] };

/** The packs, as data, sent with each call. */
export type InvoicingOptions = Pick<BooksOptions, "packs">;

export class Invoicing {
    readonly component: ComponentApi;
    readonly #scope: { packs?: ReturnType<typeof asValue.packs> };

    constructor(component: ComponentApi, options: InvoicingOptions = {}) {
        this.component = component;
        this.#scope = options.packs === undefined ? {} : { packs: asValue.packs(options.packs) };
    }

    /**
     * One tenant's books with this ctx: core's `Books`, the same object every
     * backend gives, refusing with `InvoiceError` as every backend does.
     * Arguments are checked against core's shapes before they reach Convex,
     * so malformed input is refused with a code and a path, not a validator
     * error.
     */
    books(ctx: RunMutationCtx & RunQueryCtx, tenant: string): Books {
        const call = async <T>(run: () => Promise<T>): Promise<T> => {
            try {
                return await run();
            } catch (e) {
                throw refusalOf(e) ?? e;
            }
        };
        return {
            configure: (settings) => call(() => this.configure(ctx, tenant, parse(shapes.Settings, settings))),
            create: (document) => call(() => this.create(ctx, tenant, parse(shapes.NewDocument, document))),
            update: (id, document) => call(() => this.update(ctx, tenant, id, parse(shapes.NewDocument, document))),
            discard: (id) => call(() => this.discard(ctx, tenant, id)),
            issue: (id) => call(() => this.issue(ctx, tenant, id)),
            void: (id, reason) => call(() => this.void(ctx, tenant, id, reason)),
            settle: (id, settlement) => call(() => this.settle(ctx, tenant, id, parse(shapes.NewSettlement, settlement, "settlement"))),
            reverseSettlement: (id, settlementId, reason) => call(() => this.reverseSettlement(ctx, tenant, id, settlementId, reason)),
            requestDelivery: (id, delivery) => call(() => this.requestDelivery(ctx, tenant, id, parse(shapes.DeliveryRequest, delivery, "delivery"))),
            completeDelivery: (id, deliveryId, status, detail) => call(() => this.completeDelivery(ctx, tenant, id, deliveryId, status, detail)),
            credit: (invoiceId, note) => call(() => this.credit(ctx, tenant, invoiceId, { id: note.id, input: parse(shapes.CreditNoteInput, note.input, "note.input") })),
            get: (id) => call(async () => (await this.get(ctx, tenant, id)) ?? undefined),
            getByNumber: (number) => call(async () => (await this.getByNumber(ctx, tenant, number)) ?? undefined),
            list: (query) => call(() => this.list(ctx, tenant, query === undefined ? undefined : parse(shapes.ListQuery, query))),
            events: (after, limit) => call(() => this.events(ctx, tenant, after, limit)),
            rebuildListings: (cursor) => call(() => this.rebuildListings(ctx, tenant, cursor)),
        };
    }

    private scope(tenant: string) {
        return { tenant, ...this.#scope };
    }

    /** Replaces the given settings, keeping the others. */
    async configure(ctx: RunMutationCtx, tenant: string, settings: Settings): Promise<void> {
        await ctx.runMutation(this.component.lib.configure, { ...this.scope(tenant), settings: asValue.settings(settings) });
    }

    /** A new draft. Fields the tenant's settings supply may be left out; the id is generated when absent. */
    create(ctx: RunMutationCtx, tenant: string, document: NewDocument): Promise<DocumentState> {
        return ctx.runMutation(this.component.lib.create, { ...this.scope(tenant), document: asValue.document(document) });
    }

    update(ctx: RunMutationCtx, tenant: string, id: string, document: NewDocument): Promise<DocumentState> {
        return ctx.runMutation(this.component.lib.update, { ...this.scope(tenant), id, document: asValue.document(document) });
    }

    discard(ctx: RunMutationCtx, tenant: string, id: string): Promise<DocumentState> {
        return ctx.runMutation(this.component.lib.discard, { ...this.scope(tenant), id });
    }

    /** Takes the next number in the document's series in the same transaction. */
    issue(ctx: RunMutationCtx, tenant: string, id: string): Promise<DocumentState> {
        return ctx.runMutation(this.component.lib.issue, { ...this.scope(tenant), id });
    }

    void(ctx: RunMutationCtx, tenant: string, id: string, reason: string): Promise<DocumentState> {
        return ctx.runMutation(this.component.lib.voidDocument, { ...this.scope(tenant), id, reason });
    }

    settle(ctx: RunMutationCtx, tenant: string, id: string, settlement: NewSettlement): Promise<DocumentState> {
        return ctx.runMutation(this.component.lib.settle, { ...this.scope(tenant), id, settlement });
    }

    reverseSettlement(ctx: RunMutationCtx, tenant: string, id: string, settlementId: string, reason: string): Promise<DocumentState> {
        return ctx.runMutation(this.component.lib.reverseSettlement, { ...this.scope(tenant), id, settlementId, reason });
    }

    requestDelivery(ctx: RunMutationCtx, tenant: string, id: string, delivery: DeliveryRequest): Promise<DocumentState> {
        return ctx.runMutation(this.component.lib.requestDelivery, { ...this.scope(tenant), id, delivery });
    }

    completeDelivery(ctx: RunMutationCtx, tenant: string, id: string, deliveryId: string, status: DeliveryStatus, detail?: string): Promise<DocumentState> {
        return ctx.runMutation(this.component.lib.completeDelivery, { ...this.scope(tenant), id, deliveryId, status, ...(detail !== undefined && { detail }) });
    }

    /** Issues a credit note against an issued invoice and applies it to both. */
    credit(ctx: RunMutationCtx, tenant: string, invoiceId: string, note: { id: string; input: CreditNoteInput }): Promise<{ invoice: DocumentState; note: DocumentState }> {
        return ctx.runMutation(this.component.lib.credit, { ...this.scope(tenant), invoiceId, note: { id: note.id, input: asValue.creditNote(note.input) } });
    }

    /** Rewrites a page of listings from their documents; call again with `next` until it is absent. */
    rebuildListings(ctx: RunMutationCtx, tenant: string, cursor?: string): Promise<{ next?: string }> {
        return ctx.runMutation(this.component.lib.rebuildListings, { ...this.scope(tenant), ...(cursor !== undefined && { cursor }) });
    }

    get(ctx: RunQueryCtx, tenant: string, id: string): Promise<DocumentState | null> {
        return ctx.runQuery(this.component.lib.get, { tenant, id });
    }

    getByNumber(ctx: RunQueryCtx, tenant: string, number: string): Promise<DocumentState | null> {
        return ctx.runQuery(this.component.lib.getByNumber, { tenant, number });
    }

    /**
     * The tenant's documents, newest first, filtered by kind, status and
     * customer. Pass a page's `next` as `cursor` for the one after; a page can
     * be short and still have a `next`.
     */
    list(ctx: RunQueryCtx, tenant: string, query?: ListQuery): Promise<ListPage> {
        return ctx.runQuery(this.component.lib.list, { ...this.scope(tenant), ...(query !== undefined && { query: asValue.query(query) }) });
    }

    /** The tenant's log after position `after` (default 0): at most `limit` events (default 100, at most 1000), and possibly fewer. */
    events(ctx: RunQueryCtx, tenant: string, after?: number, limit?: number): Promise<StoredEvent[]> {
        return ctx.runQuery(this.component.lib.events, { tenant, ...(after !== undefined && { after }), ...(limit !== undefined && { limit }) });
    }
}

/** The refusal a component call threw, as core's `InvoiceError`; undefined if the error is something else. */
export function refusalOf(error: unknown): InvoiceError | undefined {
    return error instanceof ConvexError ? InvoiceError.from(error.data) : undefined;
}
