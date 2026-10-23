/**
 * The behaviour every backend must show. A backend's test file calls
 * `booksConformance("convex", makeBooks)`; `makeBooks` returns fresh, empty
 * books configured with the bundled packs (eu, my, jp) in Asia/Kuala_Lumpur.
 *
 * The suite drives books only through the `Books` interface, so it tests the
 * backend's transactions, numbering and storage, not just the core.
 */
import { describe, expect, it } from "vitest";
import type { Books } from "../books.ts";
import { balance } from "../document/balance.ts";
import { evolve } from "../document/execute.ts";
import type { DocumentState, DraftData, IssuedState } from "../document/types.ts";
import { InvoiceError, type InvoiceErrorCode } from "../errors.ts";

export const sampleInvoice = (overrides: Partial<DraftData> = {}): DraftData => ({
    kind: "invoice",
    policy: "my-pint@1",
    currency: "MYR",
    issueDate: "2026-10-23",
    due: { days: 30 },
    seller: { name: "Kedai Kopi Sdn Bhd", ids: [{ scheme: "TIN", value: "C1234567890" }] },
    buyer: { name: "Acme Trading", email: "ap@acme.example" },
    lines: [
        { id: "1", name: "Consulting", quantity: "10", unit: "HUR", price: "150.00", taxes: [{ category: "SE", rate: "8" }] },
        { id: "2", name: "Kopi beans 1kg", quantity: "3", price: "45.90", taxes: [{ category: "SA", rate: "10" }] },
    ],
    ...overrides,
});

const refused = async (code: InvoiceErrorCode, action: Promise<unknown>) => {
    const error = await action.then(
        () => undefined,
        (e: unknown) => e,
    );
    expect(error, `expected refusal ${code}`).toBeDefined();
    // A backend may rethrow across a boundary (Convex, RPC); the code must survive.
    expect(error instanceof InvoiceError ? error.code : (error as { data?: { code?: string } })?.data?.code ?? String(error)).toContain(code);
};

const issued = (s: DocumentState) => {
    expect(s.status).toBe("issued");
    return s as IssuedState;
};

export function booksConformance(name: string, makeBooks: () => Promise<Books> | Books): void {
    describe(`${name}: books conformance`, () => {
        it("issues invoices with consecutive numbers per series and fixes their figures", async () => {
            const books = await makeBooks();
            await books.create("a", sampleInvoice());
            await books.create("b", sampleInvoice());
            const a = issued(await books.issue("a"));
            const b = issued(await books.issue("b"));
            expect([a.number, b.number]).toEqual(["INV-2026-00001", "INV-2026-00002"]);
            expect(a.figures.totals).toMatchObject({ lineNet: "1637.70", tax: "133.77", payable: "1771.47" });
            expect(a.dueDate).toBe("2026-11-22");
        });

        it("a refused issue consumes no number", async () => {
            const books = await makeBooks();
            await books.create("bad", sampleInvoice({ lines: [{ id: "1", name: "x", quantity: "1", price: "1.00", taxes: [{ category: "VAT-NOPE", rate: "5" }] }] }));
            await refused("invalid-tax", books.issue("bad"));
            await books.create("good", sampleInvoice());
            expect(issued(await books.issue("good")).number).toBe("INV-2026-00001");
        });

        it("repeating a command that already happened changes nothing", async () => {
            const books = await makeBooks();
            await books.create("a", sampleInvoice());
            await books.create("a", sampleInvoice());
            const first = issued(await books.issue("a"));
            const again = issued(await books.issue("a"));
            expect(again.number).toBe(first.number);
            expect(again.version).toBe(first.version);
            const pay = { id: "p1", kind: "payment" as const, amount: "100.00", date: "2026-10-24", reference: "FPX-1" };
            await books.settle("a", pay);
            const paidTwice = issued(await books.settle("a", pay));
            expect(paidTwice.settlements).toHaveLength(1);
            await refused("duplicate-id", books.settle("a", { ...pay, amount: "50.00" }));
        });

        it("a draft is editable; an issued document is not", async () => {
            const books = await makeBooks();
            await books.create("a", sampleInvoice());
            const updated = await books.update("a", sampleInvoice({ note: "Thank you" }));
            expect(updated.data.note).toBe("Thank you");
            await books.issue("a");
            await refused("invalid-transition", books.update("a", sampleInvoice()));
            await refused("invalid-transition", books.discard("a"));
        });

        it("payments settle an invoice; overpayment is refused; a reversal reopens it", async () => {
            const books = await makeBooks();
            await books.create("a", sampleInvoice());
            await books.issue("a");
            await books.settle("a", { id: "p1", kind: "payment", amount: "1000.00", date: "2026-10-25" });
            let doc = issued((await books.get("a"))!);
            expect(balance(doc, "2026-10-25")).toMatchObject({ outstanding: "771.47", status: "partial", overdue: false });
            await refused("overpayment", books.settle("a", { id: "p2", kind: "payment", amount: "771.48", date: "2026-10-26" }));
            await books.settle("a", { id: "p2", kind: "payment", amount: "771.47", date: "2026-10-26" });
            doc = issued((await books.get("a"))!);
            expect(balance(doc, "2026-12-31")).toMatchObject({ outstanding: "0.00", status: "settled", overdue: false });
            doc = issued(await books.reverseSettlement("a", "p2", "bounced"));
            expect(balance(doc, "2026-12-31")).toMatchObject({ outstanding: "771.47", status: "partial", overdue: true, daysOverdue: 39 });
        });

        it("voiding needs no live settlements, and happens once", async () => {
            const books = await makeBooks();
            await books.create("a", sampleInvoice());
            await books.issue("a");
            await books.settle("a", { id: "p1", kind: "payment", amount: "10.00", date: "2026-10-25" });
            await refused("has-settlements", books.void("a", "wrong buyer"));
            await books.reverseSettlement("a", "p1", "refunded");
            expect((await books.void("a", "wrong buyer")).status).toBe("void");
            expect((await books.void("a", "wrong buyer")).status).toBe("void");
            await refused("invalid-transition", books.settle("a", { id: "p2", kind: "payment", amount: "1.00", date: "2026-10-26" }));
        });

        it("a credit note settles part of its invoice, numbered in its own series", async () => {
            const books = await makeBooks();
            await books.create("inv", sampleInvoice());
            await books.issue("inv");
            const input = { issueDate: "2026-10-30", lines: [{ id: "1", name: "Consulting (1 hour not delivered)", quantity: "1", price: "150.00", taxes: [{ category: "SE", rate: "8" }] }] };
            const { invoice, note } = await books.credit("inv", { id: "cn1", input });
            const n = issued(note);
            expect(n.number).toBe("CN-2026-00001");
            expect(n.data).toMatchObject({ kind: "credit-note", corrects: "inv", currency: "MYR" });
            expect(balance(n, "2026-10-30").status).toBe("settled");
            expect(balance(issued(invoice), "2026-10-30")).toMatchObject({ settled: "162.00", outstanding: "1609.47", status: "partial" });

            const retry = await books.credit("inv", { id: "cn1", input });
            expect(issued(retry.note).version).toBe(n.version);
            const big = { lines: [{ id: "1", name: "Everything", quantity: "1", price: "5000.00", taxes: [{ category: "SE", rate: "8" }] }] };
            await refused("credit-exceeds-outstanding", books.credit("inv", { id: "cn2", input: big }));
            await books.create("inv2", sampleInvoice());
            expect(issued(await books.issue("inv2")).number).toBe("INV-2026-00002");
            const { note: n2 } = await books.credit("inv2", { id: "cn3", input });
            expect(issued(n2).number).toBe("CN-2026-00002");
        });

        it("records deliveries and their outcomes", async () => {
            const books = await makeBooks();
            await books.create("a", sampleInvoice());
            await books.issue("a");
            await books.requestDelivery("a", { id: "d1", channel: "email", to: "ap@acme.example" });
            await books.requestDelivery("a", { id: "d1", channel: "email", to: "ap@acme.example" });
            const doc = issued(await books.completeDelivery("a", "d1", "delivered"));
            expect(doc.deliveries).toHaveLength(1);
            expect(doc.deliveries[0]!.outcome?.status).toBe("delivered");
            await refused("invalid-transition", books.completeDelivery("a", "d1", "failed"));
        });

        it("refuses unknown documents, policies and currencies with codes", async () => {
            const books = await makeBooks();
            await refused("not-found", books.issue("nope"));
            await refused("unknown-policy", books.create("a", sampleInvoice({ policy: "xx@9" })));
            await refused("unknown-currency", books.create("a", sampleInvoice({ currency: "ABC" })));
            await refused("invalid-transition", books.create("cn", sampleInvoice({ kind: "credit-note", corrects: "a" })));
            await refused("invalid-date", books.create("a", sampleInvoice({ due: { days: 1e300 } })));
            await books.create("odd", sampleInvoice({ lines: [{ id: "1", name: "x", quantity: "1", price: "1.00", taxes: [{ category: "constructor", rate: "5" }] }] }));
            await refused("invalid-tax", books.issue("odd"));
        });

        it("concurrent payments are serialised: all fit, or exactly the excess is refused", async () => {
            const books = await makeBooks();
            await books.create("a", sampleInvoice({ lines: [{ id: "1", name: "x", quantity: "1", price: "100.00", taxes: [{ category: "E" }] }] }));
            await books.issue("a");
            const results = await Promise.allSettled(
                Array.from({ length: 11 }, (_, i) => books.settle("a", { id: `p${i}`, kind: "payment", amount: "10.00", date: "2026-10-25" })),
            );
            expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(10);
            expect(balance(issued((await books.get("a"))!), "2026-10-25").outstanding).toBe("0.00");
        });

        it("concurrent issues get unique, gapless numbers", async () => {
            const books = await makeBooks();
            const ids = Array.from({ length: 12 }, (_, i) => `d${i}`);
            for (const id of ids) await books.create(id, sampleInvoice());
            const docs = await Promise.all(ids.map((id) => books.issue(id)));
            const numbers = docs.map((d) => issued(d).number).sort();
            expect(numbers).toEqual(ids.map((_, i) => `INV-2026-${String(i + 1).padStart(5, "0")}`));
        });

        it("a credit stays applied: it cannot be reversed alone, and its invoice cannot be voided", async () => {
            const books = await makeBooks();
            await books.create("inv", sampleInvoice());
            await books.issue("inv");
            const input = { issueDate: "2026-10-30", lines: [{ id: "1", name: "x", quantity: "1", price: "10.00", taxes: [{ category: "E" }] }] };
            await books.credit("inv", { id: "cn", input });
            await refused("invalid-transition", books.reverseSettlement("inv", "credit:cn", "oops"));
            await refused("has-settlements", books.void("inv", "oops"));
            await refused("invalid-date", books.credit("inv", { id: "cn-early", input: { ...input, issueDate: "2026-10-01" } }));
        });

        it("a retried payment is a repeat whatever way its amount is written", async () => {
            const books = await makeBooks();
            await books.create("a", sampleInvoice());
            await books.issue("a");
            const pay = { id: "p1", kind: "payment" as const, amount: "100", date: "2026-10-24" };
            await books.settle("a", pay);
            await books.settle("a", pay);
            const again = issued(await books.settle("a", { ...pay, amount: "100.00" }));
            expect(again.settlements.map((s) => s.amount)).toEqual(["100.00"]);
        });

        it("a balance on a date counts only what was settled by then", async () => {
            const books = await makeBooks();
            await books.create("a", sampleInvoice());
            await books.issue("a");
            await books.settle("a", { id: "p1", kind: "payment", amount: "1771.47", date: "2027-01-05" });
            const doc = issued((await books.get("a"))!);
            expect(balance(doc, "2026-12-31")).toMatchObject({ status: "open", overdue: true });
            expect(balance(doc, "2027-01-05").status).toBe("settled");
            expect(balance(doc).status).toBe("settled");
        });

        it("a refused command leaves no trace in the log", async () => {
            const books = await makeBooks();
            await books.create("a", sampleInvoice());
            await books.issue("a");
            const before = await books.events(0, 1000);
            await refused("overpayment", books.settle("a", { id: "p1", kind: "payment", amount: "9999.00", date: "2026-10-24" }));
            await refused("invalid-transition", books.update("a", sampleInvoice()));
            expect(await books.events(0, 1000)).toEqual(before);
            expect((await books.get("a"))!.version).toBe(before.at(-1)!.version);
        });

        it("pages through the log by position", async () => {
            const books = await makeBooks();
            for (const id of ["a", "b", "c"]) await books.create(id, sampleInvoice());
            await books.issue("a");
            expect((await books.events(1, 2)).map((e) => e.position)).toEqual([2, 3]);
            expect((await books.events(4)).map((e) => e.position)).toEqual([]);
            await refused("invalid-argument", books.events(-1));
            await refused("invalid-argument", books.events(0, 0));
            await refused("invalid-argument", books.events(0, 100_000));
        });

        it("keeps tenants apart: their own documents, numbers and log", async () => {
            const one = await makeBooks();
            const two = await makeBooks();
            await one.create("a", sampleInvoice());
            await two.create("a", sampleInvoice({ note: "tenant two" }));
            expect([issued(await one.issue("a")).number, issued(await two.issue("a")).number]).toEqual(["INV-2026-00001", "INV-2026-00001"]);
            expect((await one.get("a"))!.data.note).toBeUndefined();
            expect((await two.events(0, 1000)).every((e) => e.documentId === "a")).toBe(true);
            expect(await one.events(0, 1000)).toHaveLength(2);
        });

        it("takes its numbering from settings, and never issues a number twice", async () => {
            const books = await makeBooks();
            await refused("invalid-argument", books.configure({ timeZone: "Mars/Olympus" }));
            await refused("invalid-argument", books.configure({ numbering: { invoice: { prefix: "X-", digits: 0 }, "credit-note": { prefix: "C-", digits: 2 } } }));
            await books.configure({ numbering: { invoice: { prefix: "KK/{yyyy}/", digits: 2 }, "credit-note": { prefix: "KK/CN/", digits: 2 } } });
            for (const id of ["a", "b", "c"]) await books.create(id, sampleInvoice());
            expect(issued(await books.issue("a")).number).toBe("KK/2026/01");
            // A new prefix whose first number reads like an old one: refused, and it draws no number.
            await books.configure({ numbering: { invoice: { prefix: "KK/2026/0", digits: 1 }, "credit-note": { prefix: "KK/CN/", digits: 2 } } });
            await refused("duplicate-number", books.issue("b"));
            await books.configure({ numbering: { invoice: { prefix: "KK/{yyyy}/", digits: 2 }, "credit-note": { prefix: "KK/CN/", digits: 2 } } });
            expect(issued(await books.issue("c")).number).toBe("KK/2026/02");
        });

        it("replaying the event log rebuilds every document exactly", async () => {
            const books = await makeBooks();
            await books.create("a", sampleInvoice());
            await books.issue("a");
            await books.settle("a", { id: "p1", kind: "payment", amount: "10.00", date: "2026-10-25" });
            await books.credit("a", { id: "cn", input: { issueDate: "2026-10-30", lines: [{ id: "1", name: "x", quantity: "1", price: "1.00", taxes: [{ category: "E" }] }] } });
            await books.create("draft", sampleInvoice());
            const log = await books.events(0, 1000);
            expect(log.map((e) => e.position)).toEqual(log.map((_, i) => i + 1));
            const rebuilt = new Map<string, DocumentState>();
            for (const { documentId, version, event } of log) {
                const next = evolve(rebuilt.get(documentId), event);
                expect(next.version).toBe(version);
                rebuilt.set(documentId, next);
            }
            for (const [id, state] of rebuilt) expect(await books.get(id)).toEqual(state);
        });
    });
}
