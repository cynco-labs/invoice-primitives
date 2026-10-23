import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { allocate, compute, dec, Decimal, minorUnits, verify, type RoundingMode } from "../src/index.ts";
import type { InvoiceInput, LineInput, Policy, TaxInput } from "../src/calc/model.ts";

const decimal = (min: bigint, max: bigint, scale: number) =>
    fc.bigInt({ min, max }).map((n) => {
        const neg = n < 0n;
        const digits = (neg ? -n : n).toString().padStart(scale + 1, "0");
        const s = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
        return neg ? `-${s}` : s;
    });

const TAXES: TaxInput[] = [
    { category: "S", rate: "6" },
    { category: "S", rate: "8" },
    { category: "S", rate: "25" },
    { category: "AA", rate: "7.5" },
    { category: "SE", rate: "0.375" },
    { category: "Z", rate: "0" },
    { category: "E" },
];
const MODES: RoundingMode[] = ["half-away-from-zero", "half-even", "floor", "toward-zero"];

const line = (scale: number, id: number): fc.Arbitrary<LineInput> =>
    fc.record({
        quantity: fc.integer({ min: 0, max: 3 }).chain((s) => decimal(-50n * 10n ** BigInt(s), 5000n * 10n ** BigInt(s), s)),
        price: fc.integer({ min: 0, max: 4 }).chain((s) => decimal(0n, 10n ** 7n, s)),
        baseQuantity: fc.option(fc.constantFrom("1", "10", "12.5"), { nil: undefined }),
        allowances: fc.array(
            fc.oneof(
                fc.record({ percent: decimal(0n, 50n, 0), base: decimal(0n, 10n ** BigInt(scale + 4), scale) }),
                decimal(0n, 10n ** BigInt(scale + 2), scale).map((amount) => ({ amount })),
            ),
            { maxLength: 2 },
        ),
        tax: fc.constantFrom(...TAXES),
    }).map(({ tax, baseQuantity, ...l }) => ({
        id: String(id),
        ...l,
        ...(baseQuantity && { baseQuantity }),
        taxes: [tax],
    }));

const invoice = (currencies: string[], withDocumentAdjustments: boolean) =>
    fc.constantFrom(...currencies).chain((currency) => {
        const scale = minorUnits(currency);
        const adjustment = fc.record({
            amount: decimal(0n, 10n ** BigInt(scale + 3), scale),
            taxes: fc.constantFrom(...TAXES).map((t) => [t]),
        });
        return fc.record({
            currency: fc.constant(currency),
            lines: fc.integer({ min: 1, max: 25 }).chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => line(scale, i + 1)))),
            allowances: withDocumentAdjustments ? fc.array(adjustment, { maxLength: 3 }) : fc.constant([]),
            charges: withDocumentAdjustments ? fc.array(adjustment, { maxLength: 2 }) : fc.constant([]),
        }) as fc.Arbitrary<InvoiceInput>;
    });

const policy = (pricesIncludeTax: false | "extract" | "reconcile") =>
    fc.record({
        line: fc.boolean(),
        amounts: fc.constantFrom(...MODES),
        tax: fc.constantFrom(...MODES),
    }).map(({ line, amounts, tax }): Policy =>
        line && pricesIncludeTax !== "reconcile"
            ? { id: "prop@1", taxRounding: "line", rounding: { amounts, tax }, pricesIncludeTax }
            : { id: "prop@1", taxRounding: "document", rounding: { amounts, tax }, pricesIncludeTax },
    );

/** Appends the return of some lines (quantity negated), so groups can net to zero. */
const withReturns = (arb: fc.Arbitrary<InvoiceInput>) =>
    arb.chain((input) =>
        fc.subarray([...input.lines]).map((returned) => ({
            ...input,
            lines: [
                ...input.lines,
                ...returned.map((l) => ({ ...l, id: `${l.id}-return`, quantity: dec(l.quantity).neg().toString() })),
            ],
        })),
    );

const RUNS = { numRuns: 2000 };

describe("properties", () => {
    it("tax-exclusive invoices always satisfy BR-CO-10..17 and the per-category taxable amounts", () => {
        fc.assert(
            fc.property(withReturns(invoice(["MYR", "JPY", "KWD", "EUR"], true)), policy(false), (input, p) => {
                expect(verify(compute(input, p))).toEqual([]);
            }),
            RUNS,
        );
    });

    it("every figure carries exactly the currency's decimals", () => {
        fc.assert(
            fc.property(invoice(["JPY", "KWD", "MYR"], true), policy(false), (input, p) => {
                const out = compute(input, p);
                const scale = minorUnits(input.currency);
                const figures = [
                    ...Object.values(out.totals),
                    ...out.lines.map((l) => l.net),
                    ...out.taxes.flatMap((t) => [t.taxable, t.tax]),
                ];
                for (const f of figures) expect(f.scale).toBe(scale);
            }),
            RUNS,
        );
    });

    it.each(["extract", "reconcile"] as const)("tax-inclusive (%s): the amount due is the sum of shelf prices", (mode) => {
        fc.assert(
            fc.property(withReturns(invoice(["MYR", "JPY", "KWD"], false)), policy(mode), (input, p) => {
                const out = compute(input, p);
                expect(verify(out)).toEqual([]);
                for (const l of out.lines) {
                    const shelf = l.gross.add(Decimal.sum(l.charges.map((c) => c.amount))).sub(Decimal.sum(l.allowances.map((a) => a.amount)));
                    // A net never takes the opposite sign of the line's shelf amount, beyond a few units of rounding.
                    expect(l.net.sign() * shelf.sign() >= 0 || l.net.abs().coef <= 3n).toBe(true);
                }
                expect(out.totals.payable.eq(Decimal.sum(out.lines.map((l) => l.gross)).sub(sumAdjustments(out)))).toBe(true);
            }),
            RUNS,
        );
    });

    it("recomputing gives the same result, byte for byte", () => {
        fc.assert(
            fc.property(invoice(["MYR", "KWD"], true), policy(false), (input, p) => {
                expect(JSON.stringify(compute(input, p))).toBe(JSON.stringify(compute(structuredClone(input), p)));
            }),
            RUNS,
        );
    });

    it("allocate never gains or loses a unit", () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 0, max: 3 }),
                fc.bigInt({ min: -(10n ** 9n), max: 10n ** 9n }),
                fc.array(fc.bigInt({ min: -(10n ** 6n), max: 10n ** 6n }), { minLength: 1, maxLength: 30 }),
                (scale, units, weights) => {
                    const ws = weights.map((w) => dec(w));
                    fc.pre(!Decimal.sum(ws).isZero());
                    const total = dec(units).div(dec(10n ** BigInt(scale)), scale, "toward-zero");
                    const parts = allocate(total, ws, scale);
                    expect(parts).toHaveLength(ws.length);
                    expect(Decimal.sum(parts).eq(total)).toBe(true);
                    for (const p of parts) expect(p.scale).toBe(scale);
                },
            ),
            RUNS,
        );
    });
});

/** Line allowances and charges sit inside the gross the customer saw. */
function sumAdjustments(out: ReturnType<typeof compute>): Decimal {
    return Decimal.sum(out.lines.flatMap((l) => [...l.allowances.map((a) => a.amount), ...l.charges.map((c) => c.amount.neg())]));
}
