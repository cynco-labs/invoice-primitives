import { describe, expect, it } from "vitest";
import { createMemoryBooks, createRegistry, present, renderHtml, type DraftData, type IssuedState } from "../src/index.ts";
import { bundledPacks } from "../src/packs/index.ts";
import { sampleInvoice } from "../src/testing/conformance.ts";

/** Intl separates the currency with a no-break space. */
const nb = (s: string) => s.replace(/ /g, "\u00a0");

const issuedSample = async (overrides: Partial<DraftData> = {}) => {
    const books = createMemoryBooks({ registry: createRegistry(bundledPacks), timeZone: "Asia/Kuala_Lumpur" });
    await books.create({ id: "a", ...sampleInvoice(overrides) });
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

    it("speaks any language: every printed word is a label", async () => {
        const malay = {
            invoice: "Invois",
            subtotal: "Jumlah kecil",
            tax: "Cukai",
            total: "Jumlah",
            paid: "Dibayar",
            amountDue: "Baki perlu dibayar",
            statusPartlyPaid: "Dibayar sebahagian",
        };
        const view = present(await issuedSample(), { locale: "ms-MY", asOf: "2026-10-25", labels: malay });
        expect([view.title, view.status, view.totals.map((t) => t.label)]).toEqual([
            "Invois",
            "Dibayar sebahagian",
            ["Jumlah kecil", "Cukai", "Jumlah", "Dibayar", "Baki perlu dibayar"],
        ]);
    });

    it("shows a credit note as applied, with the number of the invoice it corrects", async () => {
        const books = createMemoryBooks({ registry: createRegistry(bundledPacks), timeZone: "Asia/Kuala_Lumpur" });
        await books.create({ id: "inv", ...sampleInvoice() });
        await books.issue("inv");
        const { note } = await books.credit("inv", { id: "cn", input: { issueDate: "2026-10-30", lines: [{ id: "1", name: "x", quantity: "1", price: "10.00", taxes: [{ category: "E" }] }] } });
        const view = present(note as IssuedState, { locale: "en-MY", asOf: "2026-10-30" });
        expect([view.title, view.status, view.corrects]).toEqual(["Credit note", "Applied", "INV-2026-00001"]);
        expect(view.totals.map((t) => t.label)).toEqual(["Subtotal", "Tax", "Total"]);
    });

    it("brands the HTML and refuses unsafe brand values", async () => {
        const view = present(await issuedSample(), { locale: "en-MY", asOf: "2026-10-25" });
        const html = renderHtml(view, { logoUrl: "https://kopi.example/logo.png", accent: "#0f766e", footer: "Maybank 5140 1234 5678" });
        expect(html).toContain('<img src="https://kopi.example/logo.png"');
        expect(html).toContain("color:#0f766e");
        expect(html).toContain("Maybank 5140 1234 5678");
        const hostile = renderHtml(view, { logoUrl: "javascript:alert(1)", accent: "red;background:url(x)" });
        expect(hostile).not.toContain("javascript:");
        expect(hostile).not.toContain("url(x)");
    });
});
