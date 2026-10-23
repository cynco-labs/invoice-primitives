/** The README's quick start, as written except that the clock is pinned, so the front page cannot drift from the code. */
import { expect, it } from "vitest";
import { balance, bundledPacks, createMemoryBooks, present, renderHtml, type CountryPack, type IssuedState } from "../src/index.ts";

it("README quick start", async () => {
    const books = createMemoryBooks({ now: () => "2026-10-23T02:00:00Z" });
    await books.configure({ country: "MY", seller: { name: "Kedai Kopi Sdn Bhd" } });

    const draft = await books.create({
        buyer: { name: "Acme Trading", email: "ap@acme.example" },
        due: { days: 30 },
        lines: [{ name: "Consulting", quantity: "10", price: "150.00", tax: "service-8" }],
    });
    const invoice = (await books.issue(draft.id)) as IssuedState;
    expect([invoice.number, invoice.figures.totals.payable, invoice.issueDate]).toEqual(["INV-2026-00001", "1620.00", "2026-10-23"]);
    await books.settle(draft.id, { id: "fpx_123", kind: "payment", amount: "620.00", date: "2026-10-25" });

    const doc = (await books.get(draft.id)) as IssuedState;
    expect(balance(doc, "2026-10-25")).toMatchObject({ outstanding: "1000.00", status: "partial", overdue: false });
    const html = renderHtml(present(doc, { locale: "en-MY", asOf: "2026-10-25" }), { logoUrl: "https://kopi.example/logo.png", accent: "#0f766e" });
    expect(html).toContain("INV-2026-00001");
});

it("guide: lists", async () => {
    const books = createMemoryBooks({ now: () => "2026-12-01T02:00:00Z" });
    await books.configure({ country: "MY", seller: { name: "Kedai Kopi Sdn Bhd" } });
    const line = { name: "Consulting", quantity: "1", price: "150.00", tax: "service-8" };
    const late = await books.create({ customer: "cus_42", buyer: { name: "Acme" }, issueDate: "2026-10-01", due: { days: 30 }, lines: [line] });
    await books.issue(late.id);
    const draft = await books.create({ customer: "cus_42", buyer: { name: "Acme" }, lines: [line] });

    expect((await books.list({ status: "overdue" })).documents.map((d) => d.id)).toEqual([late.id]);
    expect((await books.list({ customer: "cus_42", limit: 20 })).documents.map((d) => d.id)).toEqual([draft.id, late.id]);
    const page = await books.list({ kind: "invoice", status: "open" });
    expect([page.documents.length, page.next]).toEqual([1, undefined]);
});

it("guide: your own jurisdiction", async () => {
    const zz: CountryPack = {
        id: "ZZ",
        policies: { standard: { id: "zz-standard@1", taxRounding: "document", rounding: { amounts: "half-away-from-zero", tax: "half-away-from-zero" }, pricesIncludeTax: false } },
        taxCategories: { S: { label: "Standard", levies: true }, E: { label: "Exempt", levies: false } },
        taxes: { "vat-7": { label: "VAT 7%", taxes: [{ category: "S", rate: "7" }], source: "https://…", checked: "2026-10-23" } },
        rules: [{ id: "ZZ-1", message: "the buyer has a TIN", source: "https://…", check: { require: "data.buyer.ids[scheme=TIN].value" } }],
        defaults: { policy: "standard", currency: "MYR", timeZone: "Asia/Kuala_Lumpur" },
        voiding: { allowed: true },
    };
    const books = createMemoryBooks({ packs: [...bundledPacks, zz] });
    await books.configure({ country: "ZZ", seller: { name: "Zed Ltd" } });
    const draft = await books.create({ buyer: { name: "Acme", ids: [{ scheme: "TIN", value: "Z1" }] }, lines: [{ name: "x", quantity: "1", price: "100.00", tax: "vat-7" }] });
    const doc = (await books.issue(draft.id)) as IssuedState;
    expect(doc.figures.totals.payable).toBe("107.00");
});
