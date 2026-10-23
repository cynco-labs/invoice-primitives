/**
 * The calculation rules as checks on a computed invoice. `compute` must never
 * produce a result that fails them; the property tests hold it to that, and
 * `issue` refuses one that does.
 *
 * A check carries an EN 16931 rule id only when it is that rule. BR-CO-17 is
 * checked under document rounding with the norm's mode (half away from zero);
 * other modes are checked against the policy and named `policy-tax-rounding`.
 * Under line rounding or "extract" pricing the per-category tax is not
 * recomputable from the subtotal, so it is not checked: such a result is
 * consistent, but not proof of EN 16931 arithmetic.
 */
import { Decimal, dec } from "../money/decimal.ts";
import { taxKey } from "./compute.ts";
import type { ComputedInvoice } from "./model.ts";

/** UNCL5305 categories EN 16931 writes a BR-<category>-08 rule for. */
const EN_CATEGORIES = new Set(["S", "Z", "E", "AE", "K", "G", "O", "L", "M"]);

export interface Violation {
    rule: string;
    message: string;
    expected: string;
    actual: string;
}

export function verify(invoice: ComputedInvoice): Violation[] {
    const { totals: t, policy } = invoice;
    const { scale } = invoice;
    const out: Violation[] = [];
    const check = (rule: string, message: string, expected: Decimal, actual: Decimal) => {
        if (!expected.eq(actual)) out.push({ rule, message, expected: expected.toString(), actual: actual.toString() });
    };
    const sum = (xs: readonly { amount: Decimal }[]) => Decimal.sum(xs.map((x) => x.amount));

    check("BR-CO-10", "sum of line net amounts", sum(invoice.lines.map((l) => ({ amount: l.net }))), t.lineNet);
    check("BR-CO-11", "sum of document allowances", sum(invoice.allowances), t.allowances);
    check("BR-CO-12", "sum of document charges", sum(invoice.charges), t.charges);
    check("BR-CO-13", "tax-exclusive total", t.lineNet.sub(t.allowances).add(t.charges), t.taxExclusive);
    check("BR-CO-14", "tax total", sum(invoice.taxes.map((x) => ({ amount: x.tax }))), t.tax);
    check("BR-CO-15", "tax-inclusive total", t.taxExclusive.add(t.tax), t.taxInclusive);
    check("BR-CO-16", "amount due", t.taxInclusive.sub(t.prepaid).add(t.rounding), t.payable);

    const compound = invoice.lines.some((l) => l.taxes.some((x) => x.compound));
    if (!compound) {
        const taxable = new Map<string, Decimal>();
        const add = (key: string, d: Decimal) => taxable.set(key, (taxable.get(key) ?? Decimal.ZERO).add(d));
        for (const line of invoice.lines) for (const x of line.taxes) add(taxKey(x), line.net);
        for (const a of invoice.allowances) for (const x of a.taxes) add(taxKey(x), a.amount.neg());
        for (const c of invoice.charges) for (const x of c.taxes) add(taxKey(x), c.amount);
        for (const sub of invoice.taxes) {
            const key = taxKey({
                scheme: sub.scheme,
                category: sub.category,
                ...(sub.rate && { rate: sub.rate.toString() }),
                ...(sub.perUnit && { perUnit: sub.perUnit.toString() }),
            });
            const rule = EN_CATEGORIES.has(sub.category) ? `BR-${sub.category}-08` : "taxable-by-category";
            check(rule, `taxable amount of ${sub.category} ${sub.rate ?? ""}`.trim(), taxable.get(key) ?? Decimal.ZERO, sub.taxable);
        }
    }

    if (policy.taxRounding === "document" && policy.pricesIncludeTax !== "extract") {
        const rule = policy.rounding.tax === "half-away-from-zero" ? "BR-CO-17" : "policy-tax-rounding";
        for (const sub of invoice.taxes) {
            if (!sub.rate) continue;
            const expected = sub.taxable.mul(sub.rate).div(dec("100"), scale, policy.rounding.tax);
            check(rule, `tax of ${sub.category} ${sub.rate}% on its taxable amount`, expected, sub.tax);
        }
    }
    return out;
}
