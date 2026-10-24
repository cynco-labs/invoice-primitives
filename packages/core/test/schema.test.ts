/** `parse` refuses with the path and message the caller needs, and agrees with the JSON Schema on bounds and keys. */
import { describe, expect, it } from "vitest";
import { createMemoryBooks, InvoiceError, isDate, type NewDocument } from "../src/index.ts";
import { parse, shapes, type Schema } from "../src/schema/index.ts";
import { sampleInvoice } from "../src/testing/conformance.ts";

const refusal = (schema: Schema<unknown>, value: unknown) => {
    try {
        parse(schema, value);
    } catch (e) {
        if (e instanceof InvoiceError) return `${e.code} ${e.path}: ${e.detail}`;
        throw e;
    }
    return "accepted";
};

const policy = { id: "x@1", rounding: { amounts: "half-away-from-zero", tax: "half-away-from-zero" } };

describe("refusals inside unions name what the caller got wrong", () => {
    it.each([
        ["payment terms as a string", shapes.NewDocument, { buyer: { name: "A" }, lines: [], due: { days: "30" } }, "invalid-argument due.days: expected a whole number, got string"],
        ["a percent allowance without its base", shapes.Adjustment, { percent: "10" }, "missing-field base: required"],
        ["line rounding cannot reconcile", shapes.Policy, { ...policy, taxRounding: "line", pricesIncludeTax: "reconcile" }, 'invalid-argument pricesIncludeTax: expected one of false, "extract"'],
        ["a void window without its reason", shapes.Voiding, { allowed: "within", hours: 72, after: "validation" }, "missing-field reason: required"],
        ["an event type that does not exist", shapes.DocumentEvent, { type: "setled", settlement: {} }, 'invalid-argument type: expected one of "created", "updated", "discarded", "issued", "voided", "settled", "settlement-reversed", "delivery-requested", "delivery-completed"'],
        ["a rounding mode that does not exist", shapes.Policy, { ...policy, rounding: { amounts: "half-up", tax: "floor" }, taxRounding: "document", pricesIncludeTax: false }, 'invalid-argument rounding.amounts: expected one of "half-away-from-zero", "half-even", "half-toward-zero", "away-from-zero", "toward-zero", "floor", "ceil"'],
    ])("%s", (_name, schema, value, expected) => {
        expect(refusal(schema, value)).toBe(expected);
    });
});

describe("strict where every backend must agree", () => {
    it("refuses a decimal with surrounding whitespace", () => {
        expect(refusal(shapes.NewSettlement, { id: "p", kind: "payment", amount: " 1\n", date: "2026-10-23" })).toBe('invalid-amount amount: " 1\\n" is not a decimal');
    });

    it("bounds numbering digits, page sizes and void windows in the shape", () => {
        expect(refusal(shapes.Numbering, { invoice: { prefix: "I-", digits: 0 }, "credit-note": { prefix: "C-", digits: 2 } })).toBe("invalid-argument invoice.digits: expected 1 to 12, got 0");
        expect(refusal(shapes.ListQuery, { limit: 201 })).toBe("invalid-argument limit: expected 1 to 200, got 201");
        expect(refusal(shapes.Voiding, { allowed: "within", hours: -1, after: "validation", reason: "r" })).toBe("invalid-argument hours: expected 0 to any, got -1");
    });

    it("reads every four-digit year as written", () => {
        expect(isDate("0050-01-01")).toBe(true);
        expect(isDate("0050-02-29")).toBe(false);
        expect(isDate("2024-02-29")).toBe(true);
    });
});

describe("books copy what crosses them", () => {
    it("a caller changing an object after create, or one get returned, changes nothing stored", async () => {
        const books = createMemoryBooks({ timeZone: "UTC" });
        const input = { id: "a", ...sampleInvoice() };
        await books.create(input);
        input.buyer.name = "changed after create";
        const got = await books.get("a");
        got!.data.buyer.name = "changed after get";
        expect((await books.get("a"))!.data.buyer.name).toBe("Acme Trading");
        expect((await books.events())[0]!.event).toMatchObject({ data: { buyer: { name: "Acme Trading" } } });
    });

    it("refuses a value JSON cannot carry, at its path", async () => {
        const books = createMemoryBooks({ timeZone: "UTC" });
        const document: NewDocument = { ...sampleInvoice() };
        Object.assign(document, { note: 1n });
        await expect(books.create(document)).rejects.toMatchObject({ code: "invalid-argument", path: "note" });
    });
});
