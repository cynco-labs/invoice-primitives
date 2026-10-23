import { describe, expect, it } from "vitest";
import { compute, draft, issue, UnsupportedError, verify, voidInvoice } from "../src/index.ts";
import { eu } from "../src/packs/eu.ts";
import { jp, jpPolicy } from "../src/packs/jp.ts";
import { my } from "../src/packs/my.ts";
import type { InvoiceInput, Policy } from "../src/model.ts";

const EN = eu.policies.en16931!;
const LINE: Policy = { id: "test-line@1", taxRounding: "line", mode: "half-away-from-zero", pricesIncludeTax: false };
const S = (rate: string) => ({ category: "S", rate });
const totals = (input: InvoiceInput, policy: Policy) => {
    const out = compute(input, policy);
    expect(verify(out)).toEqual([]);
    return JSON.parse(JSON.stringify(out.totals)) as Record<string, string>;
};

describe("scenarios", () => {
    it("allocates nothing: a document discount taxed by category (RM1,000, 8% SST, less RM100 → 972.00)", () => {
        const t = totals(
            {
                currency: "MYR",
                lines: [{ id: "1", quantity: "1", price: "1000.00", taxes: [{ category: "SA", rate: "8" }] }],
                allowances: [{ amount: "100.00", taxes: [{ category: "SA", rate: "8" }] }],
            },
            my.policies.pint!,
        );
        expect(t).toMatchObject({ taxExclusive: "900.00", tax: "72.00", payable: "972.00" });
    });

    it("rounds tax once per category, not per line", () => {
        const input: InvoiceInput = {
            currency: "EUR",
            lines: ["1", "2", "3"].map((id) => ({ id, quantity: "1", price: "0.10", taxes: [S("25")] })),
        };
        expect(totals(input, EN).tax).toBe("0.08"); // 0.30 × 25% = 0.075
        expect(totals(input, LINE).tax).toBe("0.09"); // 3 × round(0.025)
    });

    it("Japan: ¥333 tax-inclusive at 10%, fractions floored once per rate", () => {
        const out = compute(
            { currency: "JPY", lines: [{ id: "1", quantity: "1", price: "333", taxes: [S("10")] }] },
            jp.policies.floorInclusive!,
        );
        expect(verify(out)).toEqual([]);
        expect(out.taxes[0]).toMatchObject({ taxable: expect.anything() });
        expect(JSON.parse(JSON.stringify(out.totals))).toMatchObject({ taxExclusive: "303", tax: "30", payable: "333" });
    });

    it("Japan: reduced and standard rates are separate buckets", () => {
        const out = compute(
            {
                currency: "JPY",
                lines: [
                    { id: "1", quantity: "3", price: "108", taxes: [{ category: "AA", rate: "8" }] },
                    { id: "2", quantity: "1", price: "1099", taxes: [S("10")] },
                ],
            },
            jpPolicy("floor", true),
        );
        expect(verify(out)).toEqual([]);
        expect(out.taxes.map((t) => [t.category, t.tax.toString()])).toEqual([
            ["AA", "24"],
            ["S", "99"],
        ]);
        expect(out.totals.payable.toString()).toBe("1423");
    });

    it("the same ¥1,099 reconciled to EN 16931 taxes ¥100 and carries −1 in BT-114", () => {
        const out = compute(
            { currency: "JPY", lines: [{ id: "1", quantity: "1", price: "1099", taxes: [S("10")] }] },
            { ...jpPolicy("floor", true), id: "jp-en16931@1", pricesIncludeTax: "reconcile" },
        );
        expect(verify(out)).toEqual([]);
        expect(JSON.parse(JSON.stringify(out.totals))).toMatchObject({ tax: "100", rounding: "-1", payable: "1099" });
    });

    it("keeps the shelf price when no taxable amount reaches it, via BT-114", () => {
        // 0.11 at 10% inclusive: taxable 0.10 → tax 0.01 → 0.11 reachable; 0.21: 0.19+0.02=0.21.
        for (const gross of ["0.11", "0.21", "10.01", "999.99", "1.05"]) {
            const out = compute(
                { currency: "EUR", lines: [{ id: "1", quantity: "1", price: gross, taxes: [S("10")] }] },
                { ...EN, id: "en16931-inclusive@1", pricesIncludeTax: "reconcile" },
            );
            expect(verify(out)).toEqual([]);
            expect(out.totals.payable.toString()).toBe(gross);
        }
    });

    it("Malaysia: cash rounding to 5 sen lands in BT-114", () => {
        const t = totals(
            { currency: "MYR", lines: [{ id: "1", quantity: "1", price: "10.03", taxes: [{ category: "E" }] }] },
            my.policies.pintCash!,
        );
        expect(t).toMatchObject({ taxInclusive: "10.03", rounding: "0.02", payable: "10.05" });
    });

    it("Malaysia: tourism tax is a fixed amount per unit beside a rate", () => {
        const out = compute(
            {
                currency: "MYR",
                lines: [
                    {
                        id: "room",
                        quantity: "3",
                        price: "250.00",
                        taxes: [
                            { category: "SE", rate: "8" },
                            { category: "TTX", perUnit: "10.00" },
                        ],
                    },
                ],
            },
            my.policies.pint!,
        );
        expect(verify(out)).toEqual([]);
        expect(out.taxes.map((t) => [t.category, t.tax.toString()])).toEqual([
            ["SE", "60.00"],
            ["TTX", "30.00"],
        ]);
    });

    it("three-decimal currencies keep three decimals (KWD)", () => {
        const t = totals({ currency: "KWD", lines: [{ id: "1", quantity: "3", price: "1.2345", taxes: [S("5")] }] }, EN);
        expect(t).toMatchObject({ lineNet: "3.704", tax: "0.185", payable: "3.889" });
    });

    it("refuses an amount with more decimals than the currency allows", () => {
        expect(() =>
            compute({ currency: "JPY", lines: [{ id: "1", quantity: "1", price: "1", allowances: [{ amount: "0.5" }], taxes: [] }] }, EN),
        ).toThrow(RangeError);
    });

    it("compound tax under line rounding levies on net plus earlier taxes", () => {
        const out = compute(
            {
                currency: "CAD",
                lines: [{ id: "1", quantity: "1", price: "100.00", taxes: [{ category: "S", rate: "5" }, { scheme: "QST", category: "S", rate: "9.5", compound: true }] }],
            },
            LINE,
        );
        expect(verify(out)).toEqual([]);
        expect(out.totals.tax.toString()).toBe("14.98"); // 5.00 + 9.5% of 105.00
    });

    it("says what it does not compute instead of computing it wrong", () => {
        const compound = { id: "1", quantity: "1", price: "1", taxes: [S("5"), { ...S("9.5"), compound: true }] };
        expect(() => compute({ currency: "EUR", lines: [compound] }, EN)).toThrow(UnsupportedError);
        expect(() =>
            compute(
                { currency: "EUR", lines: [{ id: "1", quantity: "1", price: "1", taxes: [S("5")] }], allowances: [{ amount: "0.10", taxes: [S("5")] }] },
                { ...EN, pricesIncludeTax: "reconcile" },
            ),
        ).toThrow(UnsupportedError);
    });
});

describe("lifecycle", () => {
    const input: InvoiceInput = { currency: "MYR", lines: [{ id: "1", quantity: "1", price: "100.00", taxes: [{ category: "SA", rate: "10" }] }] };

    it("an issued invoice is frozen all the way down", () => {
        const issued = issue(draft("invoice", input), my.policies.pint!, { number: "INV-1", issueDate: "2026-10-23" });
        expect(Object.isFrozen(issued.computed.totals)).toBe(true);
        expect(() => ((issued.computed.lines as { id: string }[])[0]!.id = "x")).toThrow(TypeError);
        expect(issued.computed.policy.id).toBe("my-pint@1");
    });

    it("a note must name the invoice it corrects", () => {
        expect(() => draft("credit-note", input)).toThrow(RangeError);
        expect(draft("credit-note", input, "INV-1").corrects).toBe("INV-1");
    });

    it("MyInvois allows cancellation within 72 hours of validation, then only a credit note", () => {
        const issued = issue(draft("invoice", input), my.policies.pint!, { number: "INV-1", issueDate: "2026-10-23" });
        const validatedAt = new Date("2026-10-23T00:00:00Z");
        expect(my.canVoid(issued, new Date("2026-10-25T23:59:59Z"), { validatedAt })).toEqual({ allowed: true });
        expect(my.canVoid(issued, new Date("2026-10-26T00:00:01Z"), { validatedAt }).allowed).toBe(false);
        expect(voidInvoice(issued, "duplicate", "2026-10-24").state).toBe("void");
    });
});
