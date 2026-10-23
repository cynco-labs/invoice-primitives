import { describe, expect, it } from "vitest";
import { createMemoryBooks, createRegistry, present, renderHtml, type DraftData, type IssuedState } from "../src/index.ts";
import { bundledPacks } from "../src/packs/index.ts";
import { sampleInvoice } from "../src/testing/conformance.ts";

/** Intl separates the currency with a no-break space. */
const nb = (s: string) => s.replace(/ /g, "\u00a0");

const issuedSample = async (overrides: Partial<DraftData> = {}) => {
    const books = createMemoryBooks({ registry: createRegistry(bundledPacks), timeZone: "Asia/Kuala_Lumpur" });
    await books.create("a", sampleInvoice(overrides));
    await books.issue("a");
    await books.settle("a", { id: "p1", kind: "payment", amount: "771.47", date: "2026-10-25" });
    return (await books.get("a")) as IssuedState;
};

describe("present", () => {
    it("formats every amount in the document's currency and locale", async () => {
        const view = present(await issuedSample(), { locale: "en-MY", asOf: "2026-10-25" });
        expect(view.number).toBe("INV-2026-00001");
        expect(view.lines[0]).toMatchObject({ name: "Consulting", quantity: "10", unit: "HUR", price: nb("RM 150.00"), net: nb("RM 1,500.00"), tax: "SE 8%" });
        expect(view.totals).toEqual([
            { label: "Subtotal", amount: nb("RM 1,637.70") },
            { label: "Tax", amount: nb("RM 133.77") },
            { label: "Total", amount: nb("RM 1,771.47"), strong: true },
            { label: "Paid", amount: nb("-RM 771.47") },
            { label: "Amount due", amount: nb("RM 1,000.00"), strong: true },
        ]);
        expect(view.status).toBe("Partly paid");
        expect(present(await issuedSample(), { locale: "en-MY", asOf: "2026-12-01" }).status).toBe("Overdue by 9 days");
    });

    it("formats huge amounts exactly, not through a float", async () => {
        const view = present(
            await issuedSample({ lines: [{ id: "1", name: "x", quantity: "1", price: "90071992547409.93", taxes: [{ category: "E" }] }] }),
            { locale: "en-US", asOf: "2026-10-25" },
        );
        expect(view.totals.find((t) => t.label === "Total")!.amount).toBe(nb("MYR 90,071,992,547,409.93"));
    });

    it("renders HTML that escapes what parties typed", async () => {
        const html = renderHtml(present(await issuedSample({ buyer: { name: `<script>alert("x")</script>` } }), { locale: "en-MY", asOf: "2026-10-25" }));
        expect(html).toContain("INV-2026-00001");
        expect(html).not.toContain("<script>");
        expect(html).toContain("&#60;script&#62;");
    });
});
