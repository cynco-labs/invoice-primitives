/** The README's quick start, run as written, so the front page cannot drift from the code. */
import { expect, it } from "vitest";
import { balance, bundledPacks, createMemoryBooks, createRegistry, present, renderHtml, type IssuedState } from "../src/index.ts";

it("README quick start", async () => {
    const books = createMemoryBooks({ registry: createRegistry(bundledPacks), timeZone: "Asia/Kuala_Lumpur" });

    await books.create("inv_1", {
        kind: "invoice",
        policy: "my-pint@1",
        currency: "MYR",
        issueDate: "2026-10-23",
        due: { days: 30 },
        seller: { name: "Kedai Kopi Sdn Bhd" },
        buyer: { name: "Acme Trading", email: "ap@acme.example" },
        lines: [{ id: "1", name: "Consulting", quantity: "10", price: "150.00", taxes: [{ category: "SE", rate: "8" }] }],
    });
    const invoice = (await books.issue("inv_1")) as IssuedState;
    expect([invoice.number, invoice.figures.totals.payable]).toEqual(["INV-2026-00001", "1620.00"]);
    await books.settle("inv_1", { id: "fpx_123", kind: "payment", amount: "620.00", date: "2026-10-25" });

    const doc = (await books.get("inv_1")) as IssuedState;
    expect(balance(doc, "2026-10-25")).toMatchObject({ outstanding: "1000.00", status: "partial", overdue: false });
    expect(renderHtml(present(doc, { locale: "en-MY", asOf: "2026-10-25" }))).toContain("INV-2026-00001");
});
