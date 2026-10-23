/** The README's quick start, as written except that the clock is pinned, so the front page cannot drift from the code. */
import { expect, it } from "vitest";
import { balance, createMemoryBooks, present, renderHtml, type IssuedState } from "../src/index.ts";

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
