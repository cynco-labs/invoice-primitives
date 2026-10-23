/**
 * The app-side client: core's `Books` methods, each taking the calling
 * function's `ctx` and the tenant whose books it touches.
 *
 *   const invoicing = new Invoicing(components.invoicing, { timeZone: "Asia/Kuala_Lumpur" });
 *   await invoicing.issue(ctx, tenant, "inv_1");
 *
 * Each method runs one component mutation: one transaction. A refusal arrives
 * as a `ConvexError` whose `data` is `{ code, path, detail }` from core's
 * `InvoiceError`; use `refusalOf` to read it.
 */
import type { CreditNoteInput, DocumentState, DraftData, Settlement, StoredEvent, Numbering } from "@invoice-primitives/core";
import type { GenericDataModel, GenericMutationCtx, GenericQueryCtx } from "convex/server";
import { ConvexError } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.ts";
import type { Refusal } from "../component/lib.ts";
import { asValue } from "../component/validators.ts";

export type { ComponentApi } from "../component/_generated/component.ts";
export type { Refusal } from "../component/lib.ts";

type RunQueryCtx = { runQuery: GenericQueryCtx<GenericDataModel>["runQuery"] };
type RunMutationCtx = { runMutation: GenericMutationCtx<GenericDataModel>["runMutation"] };

export interface InvoicingOptions {
    /** The seller's IANA time zone. A document issued without an issue date is dated by the seller's calendar. */
    timeZone: string;
    /** How document numbers read. Defaults to INV-{yyyy}-00001 and CN-{yyyy}-00001. */
    numbering?: Numbering;
}

export class Invoicing {
    readonly component: ComponentApi;
    readonly timeZone: string;
    readonly numbering: Numbering | undefined;

    constructor(component: ComponentApi, options: InvoicingOptions) {
        this.component = component;
        this.timeZone = options.timeZone;
        this.numbering = options.numbering;
    }

    private scope(tenant: string) {
        return { tenant, timeZone: this.timeZone, ...(this.numbering && { numbering: this.numbering }) };
    }

    create(ctx: RunMutationCtx, tenant: string, id: string, data: DraftData): Promise<DocumentState> {
        return ctx.runMutation(this.component.lib.create, { ...this.scope(tenant), id, data: asValue.draft(data) });
    }

    update(ctx: RunMutationCtx, tenant: string, id: string, data: DraftData): Promise<DocumentState> {
        return ctx.runMutation(this.component.lib.update, { ...this.scope(tenant), id, data: asValue.draft(data) });
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

    settle(ctx: RunMutationCtx, tenant: string, id: string, settlement: Omit<Settlement, "reversed">): Promise<DocumentState> {
        return ctx.runMutation(this.component.lib.settle, { ...this.scope(tenant), id, settlement });
    }

    reverseSettlement(ctx: RunMutationCtx, tenant: string, id: string, settlementId: string, reason: string): Promise<DocumentState> {
        return ctx.runMutation(this.component.lib.reverseSettlement, { ...this.scope(tenant), id, settlementId, reason });
    }

    requestDelivery(
        ctx: RunMutationCtx,
        tenant: string,
        id: string,
        delivery: { id: string; channel: string; to: string },
    ): Promise<DocumentState> {
        return ctx.runMutation(this.component.lib.requestDelivery, { ...this.scope(tenant), id, delivery });
    }

    completeDelivery(
        ctx: RunMutationCtx,
        tenant: string,
        id: string,
        deliveryId: string,
        status: "delivered" | "failed",
        detail?: string,
    ): Promise<DocumentState> {
        return ctx.runMutation(this.component.lib.completeDelivery, {
            ...this.scope(tenant),
            id,
            deliveryId,
            status,
            ...(detail !== undefined && { detail }),
        });
    }

    /** Issues a credit note against an issued invoice and applies it to both. */
    credit(
        ctx: RunMutationCtx,
        tenant: string,
        invoiceId: string,
        note: { id: string; input: CreditNoteInput },
    ): Promise<{ invoice: DocumentState; note: DocumentState }> {
        return ctx.runMutation(this.component.lib.credit, {
            ...this.scope(tenant),
            invoiceId,
            note: { id: note.id, input: asValue.creditNote(note.input) },
        });
    }

    get(ctx: RunQueryCtx, tenant: string, id: string): Promise<DocumentState | null> {
        return ctx.runQuery(this.component.lib.get, { tenant, id });
    }

    getByNumber(ctx: RunQueryCtx, tenant: string, number: string): Promise<DocumentState | null> {
        return ctx.runQuery(this.component.lib.getByNumber, { tenant, number });
    }

    /** The tenant's log after position `after` (default 0): at most `limit` events (default 100, at most 1000). */
    events(ctx: RunQueryCtx, tenant: string, after?: number, limit?: number): Promise<StoredEvent[]> {
        return ctx.runQuery(this.component.lib.events, {
            tenant,
            ...(after !== undefined && { after }),
            ...(limit !== undefined && { limit }),
        });
    }
}

/** The refusal a component call threw, or `undefined` if the error is something else. */
export function refusalOf(error: unknown): Refusal | undefined {
    if (!(error instanceof ConvexError)) return undefined;
    const data: unknown = error.data;
    if (typeof data !== "object" || data === null || !("code" in data && "path" in data && "detail" in data)) return undefined;
    const { code, path, detail } = data;
    return typeof code === "string" && typeof path === "string" && typeof detail === "string" ? { code, path, detail } : undefined;
}
