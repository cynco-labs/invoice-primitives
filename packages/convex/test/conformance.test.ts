/**
 * Core's books conformance suite against the component, through the app-side
 * `Invoicing` client: each `Books` call is one app mutation (`t.run`) that
 * calls into the component, as an app would.
 *
 * Every suite run shares one deployment and gets its own tenant, so the suite
 * also shows that tenants' numbers, logs and documents do not mix.
 */
import type { Books } from "@invoice-primitives/core";
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
const invoicing = new Invoicing(t.registerComponent<ComponentApi>("invoicing", schema, modules));

let tenants = 0;

function books(tenant: string): Books {
    return {
        configure: async (settings) => {
            await t.run((ctx) => invoicing.configure(ctx, tenant, settings));
        },
        create: (document) => t.run((ctx) => invoicing.create(ctx, tenant, document)),
        update: (id, document) => t.run((ctx) => invoicing.update(ctx, tenant, id, document)),
        discard: (id) => t.run((ctx) => invoicing.discard(ctx, tenant, id)),
        issue: (id) => t.run((ctx) => invoicing.issue(ctx, tenant, id)),
        void: (id, reason) => t.run((ctx) => invoicing.void(ctx, tenant, id, reason)),
        settle: (id, settlement) => t.run((ctx) => invoicing.settle(ctx, tenant, id, settlement)),
        reverseSettlement: (id, settlementId, reason) => t.run((ctx) => invoicing.reverseSettlement(ctx, tenant, id, settlementId, reason)),
        requestDelivery: (id, delivery) => t.run((ctx) => invoicing.requestDelivery(ctx, tenant, id, delivery)),
        completeDelivery: (id, deliveryId, status, detail) =>
            t.run((ctx) => invoicing.completeDelivery(ctx, tenant, id, deliveryId, status, detail)),
        credit: (invoiceId, note) => t.run((ctx) => invoicing.credit(ctx, tenant, invoiceId, note)),
        get: async (id) => (await t.run((ctx) => invoicing.get(ctx, tenant, id))) ?? undefined,
        events: (after, limit) => t.run((ctx) => invoicing.events(ctx, tenant, after, limit)),
    };
}

booksConformance("convex", async () => {
    const b = books(`tenant-${++tenants}`);
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

    it("finds a document by its number", async () => {
        const a = books("by-number");
        await a.create({ id: "x", ...sampleInvoice() });
        await a.issue("x");
        expect((await t.run((ctx) => invoicing.getByNumber(ctx, "by-number", "INV-2026-00001")))?.id).toBe("x");
        expect(await t.run((ctx) => invoicing.getByNumber(ctx, "by-number", "INV-2026-00002"))).toBeNull();
    });

    it("refuses with core's code, path and detail as ConvexError data", async () => {
        const error = await books("refusals")
            .create({ id: "a", ...sampleInvoice({ currency: "ABC" }) })
            .then(() => undefined, (e: unknown) => e);
        expect(refusalOf(error)).toMatchObject({ code: "unknown-currency", path: "data.currency" });
    });

    it("refuses an empty tenant, a bad time zone and an unbounded page", async () => {
        const codeOf = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => refusalOf(e)?.path);
        expect(await codeOf(books("").create({ id: "a", ...sampleInvoice() }))).toBe("tenant");
        expect(await codeOf(books("tz").configure({ timeZone: "Mars/Olympus" }))).toBe("timeZone");
        expect(await codeOf(books("paging").events(0, 1001))).toBe("limit");
        expect(await codeOf(books("paging").events(-1))).toBe("after");
    });

    it("gives the same Books object an app's own mutation can use", async () => {
        const id = await t.run(async (ctx) => {
            const books = invoicing.books(ctx, "books-api");
            await books.configure({ country: "MY", seller: { name: "Kedai Kopi Sdn Bhd" } });
            const draft = await books.create({ buyer: { name: "Acme" }, lines: [{ name: "Consulting", quantity: "1", price: "100.00", tax: "service-8" }] });
            const doc = await books.issue(draft.id);
            return doc.status === "issued" ? doc.figures.totals.payable : "";
        });
        expect(id).toBe("108.00");
    });
});
