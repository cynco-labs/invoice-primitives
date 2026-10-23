import { describe, expect, it } from "vitest";
import { allocate, bundledPacks, compute, createRegistry, dec, InvoiceError, numberingFor, verify, type InvoiceErrorCode, type IssuedState } from "../src/index.ts";
import { sampleInvoice } from "../src/testing/conformance.ts";
import { eu } from "../src/packs/eu.ts";
import { jp, jpPolicy } from "../src/packs/jp.ts";
import { my } from "../src/packs/my.ts";
import type { DocumentRounding, InvoiceInput, LineRounding, Policy } from "../src/calc/model.ts";

const HALF_UP = { amounts: "half-away-from-zero", tax: "half-away-from-zero" } as const;
const EN: DocumentRounding = { id: "test-en@1", taxRounding: "document", rounding: HALF_UP, pricesIncludeTax: false };
const LINE: LineRounding = { id: "test-line@1", taxRounding: "line", rounding: HALF_UP, pricesIncludeTax: false };
const RECONCILE: DocumentRounding = { ...EN, id: "test-reconcile@1", pricesIncludeTax: "reconcile" };
const RECONCILE_FLOOR: DocumentRounding = { ...RECONCILE, id: "test-reconcile-floor@1", rounding: { amounts: "half-away-from-zero", tax: "floor" } };
const EXTRACT: DocumentRounding = { ...EN, id: "test-extract@1", pricesIncludeTax: "extract" };
const S = (rate: string) => ({ category: "S", rate });
const json = <T,>(x: T) => JSON.parse(JSON.stringify(x)) as Record<string, string>;
const totals = (input: InvoiceInput, policy: Policy) => {
    const out = compute(input, policy);
    expect(verify(out)).toEqual([]);
    return json(out.totals);
};
const refuses = (code: InvoiceErrorCode, path: string, f: () => unknown) => {
    try {
        f();
    } catch (e) {
        expect(e).toBeInstanceOf(InvoiceError);
        expect({ code: (e as InvoiceError).code, path: (e as InvoiceError).path }).toEqual({ code, path });
        return;
    }
    expect.fail(`expected InvoiceError ${code}`);
};

describe("scenarios", () => {
    it("a document discount taxed by its category: RM1,000 at 8% SST less RM100 is 972.00", () => {
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

    it("rounds tax once per category under document rounding, per line under line rounding", () => {
        const input: InvoiceInput = {
            currency: "EUR",
            lines: ["1", "2", "3"].map((id) => ({ id, quantity: "1", price: "0.10", taxes: [S("25")] })),
        };
        expect(totals(input, EN).tax).toBe("0.08"); // 0.30 × 25% = 0.075
        expect(totals(input, LINE).tax).toBe("0.09"); // 3 × round(0.025)
    });

    it("a percentage allowance is a percent of a stated base", () => {
        const t = totals(
            {
                currency: "EUR",
                lines: [{ id: "1", quantity: "2", price: "50.00", allowances: [{ percent: "10", base: "100.00" }], taxes: [S("20")] }],
            },
            EN,
        );
        expect(t).toMatchObject({ lineNet: "90.00", tax: "18.00" });
    });

    it("Japan: ¥333 tax-inclusive at 10%, fractions floored once per rate", () => {
        const out = compute({ currency: "JPY", lines: [{ id: "1", quantity: "1", price: "333", taxes: [S("10")] }] }, jp.policies.truncateInclusive!);
        expect(verify(out)).toEqual([]);
        expect(json(out.totals)).toMatchObject({ taxExclusive: "303", tax: "30", payable: "333" });
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

    it("Japan: the tax mode floors tax fractions only, not quantities × prices", () => {
        const out = compute({ currency: "JPY", lines: [{ id: "1", quantity: "3", price: "0.5", taxes: [S("10")] }] }, jpPolicy("floor"));
        expect(out.lines[0]!.net.toString()).toBe("2"); // 1.5 rounds half up
    });

    it("the same ¥1,099 reconciled to EN 16931 taxes ¥100 and carries −1 in BT-114", () => {
        const out = compute({ currency: "JPY", lines: [{ id: "1", quantity: "1", price: "1099", taxes: [S("10")] }] }, RECONCILE_FLOOR);
        expect(verify(out)).toEqual([]);
        expect(json(out.totals)).toMatchObject({ tax: "100", rounding: "-1", payable: "1099" });
    });

    it("reconcile keeps the shelf price for any gross", () => {
        for (const gross of ["0.11", "0.21", "10.01", "999.99", "1.05"]) {
            const out = compute({ currency: "EUR", lines: [{ id: "1", quantity: "1", price: gross, taxes: [S("10")] }] }, RECONCILE);
            expect(verify(out)).toEqual([]);
            expect(out.totals.payable.toString()).toBe(gross);
        }
    });

    it.each([EXTRACT, RECONCILE])("a sale and its full return keep opposite nets under $id", (policy) => {
        const out = compute(
            {
                currency: "EUR",
                lines: [
                    { id: "sale", quantity: "1", price: "110.00", taxes: [S("10")] },
                    { id: "return", quantity: "-1", price: "110.00", taxes: [S("10")] },
                ],
            },
            policy,
        );
        expect(verify(out)).toEqual([]);
        expect(out.lines.map((l) => l.net.toString())).toEqual(["100.00", "-100.00"]);
    });

    it("refuses a stated BT-114 that would drop the reconciled residual", () => {
        refuses("rounding-conflict", "roundingAmount", () =>
            compute({ currency: "JPY", lines: [{ id: "1", quantity: "1", price: "1099", taxes: [S("10")] }], roundingAmount: "0" }, RECONCILE_FLOOR),
        );
    });

    it("Malaysia: cash rounding to 5 sen lands in BT-114", () => {
        const t = totals({ currency: "MYR", lines: [{ id: "1", quantity: "1", price: "10.03", taxes: [{ category: "E" }] }] }, my.policies.pintCash!);
        expect(t).toMatchObject({ taxInclusive: "10.03", rounding: "0.02", payable: "10.05" });
    });

    it("Malaysia: cash rounding of a credit note is symmetric", () => {
        const t = totals({ currency: "MYR", lines: [{ id: "1", quantity: "-1", price: "10.03", taxes: [{ category: "E" }] }] }, my.policies.pintCash!);
        expect(t).toMatchObject({ rounding: "-0.02", payable: "-10.05" });
    });

    it("Malaysia: tourism tax is a fixed amount per unit beside a rate", () => {
        const out = compute(
            {
                currency: "MYR",
                lines: [{ id: "room", quantity: "3", price: "250.00", taxes: [{ category: "SE", rate: "8" }, { category: "TTX", perUnit: "10.00" }] }],
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

    it("compound tax under line rounding levies on net plus earlier taxes", () => {
        const out = compute(
            {
                currency: "CAD",
                lines: [{ id: "1", quantity: "1", price: "100.00", taxes: [S("5"), { scheme: "QST", category: "S", rate: "9.5", compound: true }] }],
            },
            LINE,
        );
        expect(verify(out)).toEqual([]);
        expect(out.totals.tax.toString()).toBe("14.98"); // 5.00 + 9.5% of 105.00
    });

    it("refuses what it cannot compute, with a code and a path", () => {
        const line = { id: "1", quantity: "1", price: "1", taxes: [S("5")] };
        refuses("unknown-currency", "currency", () => compute({ currency: "XYZ", lines: [line] }, EN));
        refuses("empty-invoice", "lines", () => compute({ currency: "EUR", lines: [] }, EN));
        refuses("duplicate-line-id", "lines[1].id", () => compute({ currency: "EUR", lines: [line, line] }, EN));
        refuses("invalid-base-quantity", "lines[0].baseQuantity", () => compute({ currency: "EUR", lines: [{ ...line, baseQuantity: "-1" }] }, EN));
        refuses("invalid-tax", "lines[0].taxes[0].rate", () => compute({ currency: "EUR", lines: [{ ...line, taxes: [S("-100")] }] }, EN));
        refuses("too-many-decimals", "lines[0].allowances[0].amount", () =>
            compute({ currency: "JPY", lines: [{ ...line, allowances: [{ amount: "0.5" }] }] }, EN),
        );
        refuses("invalid-policy", "policy.cashIncrement", () => compute({ currency: "EUR", lines: [line] }, { ...EN, cashIncrement: "0" }));
        refuses("unsupported", "lines[0].taxes", () =>
            compute({ currency: "EUR", lines: [{ ...line, taxes: [S("5"), { ...S("9.5"), compound: true }] }] }, EN),
        );
        refuses("unsupported", "allowances", () =>
            compute({ currency: "EUR", lines: [line], allowances: [{ amount: "0.10", taxes: [S("5")] }] }, RECONCILE),
        );
    });

    it("decimal and allocation refuse inputs they cannot honour exactly", () => {
        expect(() => dec("1234").round(-1, "half-even")).toThrow(RangeError);
        expect(() => dec("1.00").roundTo(dec("0"), "half-even")).toThrow(RangeError);
        expect(() => allocate(dec("1.005"), [dec("1"), dec("1")], 2)).toThrow(RangeError);
    });

    it("stamps the policy and the core version on the result", () => {
        const out = compute({ currency: "EUR", lines: [{ id: "1", quantity: "1", price: "1", taxes: [] }] }, eu.policies.en16931!);
        expect(out.policy.id).toBe("en16931@1");
        expect(out.core).toMatch(/^@invoice-primitives\/core@/);
        expect(out.scale).toBe(2);
    });
});

describe("numbering", () => {
    it("is data: a prefix with the issue year, and a width", () => {
        const ctx = { now: "2026-10-23T00:00:00Z", timeZone: "UTC", registry: createRegistry(bundledPacks) };
        const custom = { invoice: { prefix: "KK/{yyyy}/", digits: 3 }, "credit-note": { prefix: "KK-CN/", digits: 4 } };
        const inv = numberingFor(sampleInvoice({ issueDate: "2027-01-02" }), { ...ctx, numbering: custom });
        expect([inv.series, inv.format(7)]).toEqual(["KK/2027/", "KK/2027/007"]);
        expect(numberingFor(sampleInvoice({ kind: "credit-note", corrects: "x" }), { ...ctx, numbering: custom }).format(12)).toBe("KK-CN/0012");
        expect(numberingFor(sampleInvoice(), ctx).format(1)).toBe("INV-2026-00001");
    });
});

describe("country packs", () => {
    it("MyInvois allows cancellation within 72 hours of validation, then only a credit note", () => {
        const doc = {} as IssuedState;
        const validatedAt = "2026-10-23T00:00:00Z";
        expect(my.canVoid(doc, "2026-10-25T23:59:59Z", { validatedAt })).toEqual({ allowed: true });
        expect(my.canVoid(doc, "2026-10-26T00:00:01Z", { validatedAt }).allowed).toBe(false);
    });
});
