/**
 * Listing a tenant's documents without a shadow index in the app.
 *
 * A backend stores `listingOf(state)` beside each document on every save, and
 * `seq`, the log position of the document's first event, which orders the list
 * newest first and makes the cursor. `listFilter` turns a query into plain
 * comparisons on those fields, so every backend answers it the same way.
 */
import { InvoiceError } from "../errors.ts";
import { fieldNames, parse, type Infer } from "../schema/dsl.ts";
import * as S from "../schema/shapes.ts";
import { balance } from "./balance.ts";
import { localDate } from "./dates.ts";
import type { Context } from "./execute.ts";
import type { DocumentKind, DocumentState } from "./types.ts";

/**
 * Where a document stands, as a list shows it. An issued document is open
 * until its settlements cover it, counting every recorded settlement whatever
 * its date, as `balance(doc)` does without a date.
 */
export type Stage = Infer<typeof S.Stage>;
export type ListQuery = Infer<typeof S.ListQuery>;
/** A stage, or "overdue": open and due before `asOf`. */
export type ListStatus = NonNullable<ListQuery["status"]>;
export type ListPage = Infer<typeof S.ListPage>;

/** The fields a store indexes, derived from the state on every save. */
export type Listing = Infer<typeof S.Listing>;

const LISTING_FIELDS = fieldNames(S.Listing);

/** Whether two listings say the same, so a store can skip rewriting an unchanged one. */
export function sameListing(a: Listing, b: Listing): boolean {
    return LISTING_FIELDS.every((field) => a[field] === b[field]);
}

/** What a backend compares. `before` comes from the cursor; the store applies it to `seq`. */
export interface ListFilter {
    kind?: DocumentKind;
    /** One stage, or, without a status, every stage but "discarded". */
    stage: { op: "=" | "!="; value: Stage };
    customer?: string;
    /** Only documents due before this date. */
    dueBefore?: string;
    /** Only documents whose `seq` is below this. */
    before?: number;
    limit: number;
}


export function listingOf(state: DocumentState): Listing {
    const stage = state.status === "issued" ? (balance(state).status === "settled" ? "settled" : "open") : state.status;
    return {
        kind: state.data.kind,
        stage,
        ...(state.data.customer !== undefined && { customer: state.data.customer }),
        ...((state.status === "issued" || state.status === "void") && { dueDate: state.dueDate }),
    };
}

/** Checks a query and resolves it against the tenant's clock. */
export function listFilter(query: ListQuery = {}, ctx: Pick<Context, "now" | "timeZone">): ListFilter {
    const { kind, status, asOf, customer, cursor, limit = 50 } = parse(S.ListQuery, query);
    if (asOf !== undefined && status !== "overdue") {
        // A stage counts every settlement whatever its date, so no other status can honour a date.
        throw new InvoiceError("invalid-argument", "asOf", 'asOf applies only to status "overdue"; use balance(doc, asOf) for one document');
    }
    const before = cursor === undefined ? undefined : seqOf(cursor);
    return {
        ...(kind !== undefined && { kind }),
        stage: status === undefined ? { op: "!=", value: "discarded" } : { op: "=", value: status === "overdue" ? "open" : status },
        ...(status === "overdue" && { dueBefore: asOf ?? localDate(ctx.now, ctx.timeZone) }),
        ...(customer !== undefined && { customer }),
        ...(before !== undefined && { before }),
        limit,
    };
}

/** One comparison on a `Listing` field. A store that queries in its own language (SQL) translates these. */
export type Condition = { field: "kind" | "customer" | "stage"; op: "=" | "!="; value: string } | { field: "dueDate"; op: "<"; value: string };

/** What a document must satisfy to be listed, apart from its position. */
export function conditions(filter: ListFilter): Condition[] {
    const all: Condition[] = [{ field: "stage", ...filter.stage }];
    if (filter.kind !== undefined) all.push({ field: "kind", op: "=", value: filter.kind });
    if (filter.customer !== undefined) all.push({ field: "customer", op: "=", value: filter.customer });
    if (filter.dueBefore !== undefined) all.push({ field: "dueDate", op: "<", value: filter.dueBefore });
    return all;
}

/** Whether a listing meets every condition. */
export function listed(listing: Listing, all: readonly Condition[]): boolean {
    return all.every((c) => {
        switch (c.op) {
            case "=":
                return listing[c.field] === c.value;
            case "!=":
                return listing[c.field] !== c.value;
            case "<":
                return listing.dueDate !== undefined && listing.dueDate < c.value;
        }
    });
}

/**
 * A page from the listings a store's `scan` gives, newest first and already
 * below the cursor, reading at most `maxScan` of them. A page that stops
 * early, full or at the cap, has a `next`.
 */
export async function collect<R extends Listing & { seq: number }>(
    rows: AsyncIterable<R> | Iterable<R>,
    filter: ListFilter,
    maxScan = Infinity,
): Promise<{ rows: R[]; next?: string }> {
    const all = conditions(filter);
    const found: R[] = [];
    let scanned = 0;
    let last = 0;
    for await (const row of rows) {
        if (found.length === filter.limit || scanned === maxScan) return { rows: found, next: String(last) };
        scanned += 1;
        last = row.seq;
        if (listed(row, all)) found.push(row);
    }
    return { rows: found };
}

function seqOf(cursor: string): number {
    const seq = typeof cursor === "string" && /^[1-9]\d{0,15}$/.test(cursor) ? Number(cursor) : NaN;
    if (!Number.isSafeInteger(seq)) throw new InvoiceError("invalid-argument", "cursor", "pass a page's next as it came");
    return seq;
}
