/**
 * Core's books conformance suite against the component, through the app-side
 * `Invoicing` client: each `Books` call is one app mutation (`t.run`) that
 * calls into the component, as an app would.
 *
 * Every suite run shares one deployment and gets its own tenant, so the suite
 * also shows that tenants' numbers, logs and documents do not mix.
 */
import { InvoiceError, type Books, type DocumentState, type ListPage, type NewDocument, type StoredEvent } from "@invoice-primitives/core";
import { makeFunctionReference } from "convex/server";
import { booksConformance, sampleInvoice } from "@invoice-primitives/core/testing";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { Invoicing, refusalOf, type ComponentApi } from "../src/client/index.ts";
import schema from "../src/component/schema.ts";

const modules = import.meta.glob("../src/component/**/*.ts");

// The app has no functions of its own: `t.run` supplies each one inline. convex-test
// still locates an app's modules by their `_generated` directory, so give it an empty one.
const app = { "./_generated/server.ts": () => Promise.resolve({}) };
const t = convexTest(undefined, app);
const component = t.registerComponent<ComponentApi>("invoicing", schema, modules);
const defaultClient = new Invoicing(component);

let tenants = 0;

/** The client's `Books`, each call one app function (`t.run`) that calls into the component, as an app would. */
function books(tenant: string, invoicing = defaultClient): Books {
    const on = (ctx: Parameters<Parameters<typeof t.run>[0]>[0]) => invoicing.books(ctx, tenant);
    return {
        configure: (settings) => t.run((ctx) => on(ctx).configure(settings)),
        create: (document) => t.run((ctx) => on(ctx).create(document)),
        update: (id, document) => t.run((ctx) => on(ctx).update(id, document)),
        discard: (id) => t.run((ctx) => on(ctx).discard(id)),
        issue: (id) => t.run((ctx) => on(ctx).issue(id)),
        void: (id, reason) => t.run((ctx) => on(ctx).void(id, reason)),
        settle: (id, settlement) => t.run((ctx) => on(ctx).settle(id, settlement)),
        reverseSettlement: (id, settlementId, reason) => t.run((ctx) => on(ctx).reverseSettlement(id, settlementId, reason)),
        requestDelivery: (id, delivery) => t.run((ctx) => on(ctx).requestDelivery(id, delivery)),
        completeDelivery: (id, deliveryId, status, detail) => t.run((ctx) => on(ctx).completeDelivery(id, deliveryId, status, detail)),
        credit: (invoiceId, note) => t.run((ctx) => on(ctx).credit(invoiceId, note)),
        // t.run returns a function's undefined as null.
        get: async (id) => (await t.run((ctx) => on(ctx).get(id))) ?? undefined,
        getByNumber: async (number) => (await t.run((ctx) => on(ctx).getByNumber(number))) ?? undefined,
        list: (query) => t.run((ctx) => on(ctx).list(query)),
        events: (after, limit) => t.run((ctx) => on(ctx).events(after, limit)),
        rebuildListings: (cursor) => t.run((ctx) => on(ctx).rebuildListings(cursor)),
    };
}

booksConformance("convex", async (options = {}) => {
    const b = books(`tenant-${++tenants}`, new Invoicing(component, options));
    await b.configure({ timeZone: "Asia/Kuala_Lumpur" });
    return b;
});

describe("convex: tenants and the component boundary", () => {
    it("keeps each tenant's documents, numbers and log apart", async () => {
        const a = books("isolation-a");
        const b = books("isolation-b");
        await a.create({ id: "same-id", ...sampleInvoice() });
        await b.create({ id: "same-id", ...sampleInvoice({ note: "b" }) });
        await a.issue("same-id");
        const issuedB = await b.issue("same-id");
        expect(issuedB.status === "issued" && issuedB.number).toBe("INV-2026-00001");
        expect((await a.get("same-id"))?.data.note).toBeUndefined();
        expect((await a.events()).map((e) => e.position)).toEqual([1, 2]);
        expect((await b.events()).map((e) => e.position)).toEqual([1, 2]);
        expect(await books("isolation-c").get("same-id")).toBeUndefined();
    });

    it("refuses through books() with core's InvoiceError, and through the direct methods with ConvexError data", async () => {
        const viaBooks = await books("refusals")
            .create({ id: "a", ...sampleInvoice({ currency: "ABC" }) })
            .then(() => undefined, (e: unknown) => e);
        expect(viaBooks).toBeInstanceOf(InvoiceError);
        expect(viaBooks).toMatchObject({ code: "unknown-currency", path: "data.currency" });
        const direct = await t.run((ctx) => defaultClient.get(ctx, "", "x")).then(() => undefined, (e: unknown) => e);
        expect(refusalOf(direct)).toMatchObject({ code: "invalid-argument", path: "tenant" });
    });

    it("refuses an empty tenant, a bad time zone and an unbounded page", async () => {
        const pathOf = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => (e instanceof InvoiceError ? e.path : String(e)));
        expect(await pathOf(books("").create({ id: "a", ...sampleInvoice() }))).toBe("tenant");
        expect(await pathOf(books("").get("a"))).toBe("tenant");
        expect(await pathOf(books("tz").configure({ timeZone: "Mars/Olympus" }))).toBe("timeZone");
        expect(await pathOf(books("paging").events(0, 1001))).toBe("limit");
        expect(await pathOf(books("paging").events(-1))).toBe("after");
    });

    it("gives the same Books object an app's own mutation can use", async () => {
        const id = await t.run(async (ctx) => {
            const books = defaultClient.books(ctx, "books-api");
            await books.configure({ country: "MY", seller: { name: "Kedai Kopi Sdn Bhd" } });
            const draft = await books.create({ buyer: { name: "Acme" }, lines: [{ name: "Consulting", quantity: "1", price: "100.00", tax: "service-8" }] });
            const doc = await books.issue(draft.id);
            return doc.status === "issued" ? doc.figures.totals.payable : "";
        });
        expect(id).toBe("108.00");
    });
});

// The component on its own, so a test can reach its tables and write rows as an earlier version did.
const create = makeFunctionReference<"mutation", { tenant: string; document: NewDocument }, DocumentState>("lib:create");
const rebuild = makeFunctionReference<"mutation", { tenant: string; cursor?: string }, { next?: string }>("lib:rebuildListings");
const list = makeFunctionReference<"query", { tenant: string }, ListPage>("lib:list");
const events = makeFunctionReference<"query", { tenant: string }, StoredEvent[]>("lib:events");

describe("convex: data written by earlier versions", () => {
    it("rebuildListings lists a document that has no listing yet, in its place", async () => {
        const c = convexTest(schema, modules);
        await c.mutation(create, { tenant: "t", document: { id: "old", ...sampleInvoice() } });
        await c.mutation(create, { tenant: "t", document: { id: "new", ...sampleInvoice() } });
        await c.run(async (ctx) => {
            for (const row of await ctx.db.query("listings").collect()) await ctx.db.delete(row._id);
        });
        expect((await c.query(list, { tenant: "t" })).documents).toEqual([]);
        expect(await c.mutation(rebuild, { tenant: "t" })).toEqual({});
        expect((await c.query(list, { tenant: "t" })).documents.map((d) => d.id)).toEqual(["new", "old"]);
    });

    it("reads an event without a format as format 1", async () => {
        const c = convexTest(schema, modules);
        await c.mutation(create, { tenant: "t", document: { id: "old", ...sampleInvoice() } });
        await c.run(async (ctx) => {
            for (const row of await ctx.db.query("events").collect()) {
                const { _id, _creationTime, format, ...before } = row;
                await ctx.db.replace(_id, before);
            }
        });
        expect((await c.query(events, { tenant: "t" })).map((e) => e.format)).toEqual([1]);
    });
});
