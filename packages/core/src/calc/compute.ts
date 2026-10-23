/**
 * The calculation: one pure pass from an invoice's inputs to every figure
 * EN 16931 defines (BT-106..BT-117, BT-131), under a rounding policy.
 */
import { allocate } from "../money/allocate.ts";
import { MINOR_UNITS } from "../money/currencies.ts";
import { Decimal, dec } from "../money/decimal.ts";
import { InvoiceError } from "../errors.ts";
import type {
    Adjustment,
    ComputedAdjustment,
    ComputedDocumentAdjustment,
    ComputedInvoice,
    ComputedLine,
    DocumentAdjustment,
    InvoiceInput,
    Policy,
    TaxInput,
    TaxSubtotal,
} from "./model.ts";
import { CORE } from "../version.ts";

export function minorUnits(currency: string): number {
    const units = MINOR_UNITS[currency];
    if (units === undefined) throw new InvoiceError("unknown-currency", "currency", `unknown ISO 4217 currency ${currency}`);
    return units;
}

const HUNDRED = dec("100");
const ONE = dec("1");

interface Group {
    spec: TaxInput;
    taxable: Decimal;
    /** Line policy: the rounded taxes summed. Document policy: exact per-unit levies, rounded at the end. */
    levy: Decimal;
}

export function compute(input: InvoiceInput, policy: Policy): ComputedInvoice {
    const scale = minorUnits(input.currency);
    const { amounts: amountMode, tax: taxMode } = policy.rounding;
    const percentOf = (base: Decimal, percent: Decimal, mode = amountMode) => base.mul(percent).div(HUNDRED, scale, mode);
    const taxOf = (base: Decimal, rate: Decimal) => percentOf(base, rate, taxMode);

    if (policy.cashIncrement !== undefined && dec(policy.cashIncrement).sign() <= 0) {
        throw new InvoiceError("invalid-policy", "policy.cashIncrement", "must be positive");
    }
    if (input.lines.length === 0) throw new InvoiceError("empty-invoice", "lines", "an invoice has at least one line");
    const ids = new Set<string>();
    input.lines.forEach((l, i) => {
        if (ids.has(l.id)) throw new InvoiceError("duplicate-line-id", `lines[${i}].id`, `line id ${l.id} repeats`);
        ids.add(l.id);
    });

    /** A stated amount: refused when it has more precision than the currency. */
    const amount = (value: string, path: string): Decimal => {
        const d = dec(value);
        const scaled = d.round(scale, "toward-zero");
        if (!scaled.eq(d)) {
            throw new InvoiceError("too-many-decimals", path, `${value} has more than ${scale} decimals for ${input.currency}`);
        }
        return scaled;
    };

    const tax = (t: TaxInput, path: string): TaxInput => {
        if (t.rate !== undefined && t.perUnit !== undefined) {
            throw new InvoiceError("invalid-tax", path, "a tax has a rate or a per-unit amount, not both");
        }
        if (t.rate !== undefined && dec(t.rate).sign() < 0) throw new InvoiceError("invalid-tax", `${path}.rate`, "a rate is not negative");
        return { ...t };
    };

    const adjust = (a: Adjustment, path: string): ComputedAdjustment => {
        const base = a.base === undefined ? undefined : amount(a.base, `${path}.base`);
        const percent = a.percent === undefined ? undefined : dec(a.percent);
        const value = a.amount !== undefined ? amount(a.amount, `${path}.amount`) : percentOf(base!, percent!);
        return {
            amount: value,
            ...(base && { base }),
            ...(percent && { percent }),
            ...(a.reason !== undefined && { reason: a.reason }),
            ...(a.reasonCode !== undefined && { reasonCode: a.reasonCode }),
        };
    };

    const lines: ComputedLine[] = input.lines.map((l, i) => {
        const path = `lines[${i}]`;
        const baseQuantity = l.baseQuantity === undefined ? ONE : dec(l.baseQuantity);
        if (baseQuantity.sign() <= 0) throw new InvoiceError("invalid-base-quantity", `${path}.baseQuantity`, "must be positive");
        const quantity = dec(l.quantity);
        const gross = quantity.mul(dec(l.price)).div(baseQuantity, scale, amountMode);
        const allowances = (l.allowances ?? []).map((a, j) => adjust(a, `${path}.allowances[${j}]`));
        const charges = (l.charges ?? []).map((c, j) => adjust(c, `${path}.charges[${j}]`));
        const net = gross.add(sumOf(charges)).sub(sumOf(allowances));
        const taxes = l.taxes.map((t, j) => tax(t, `${path}.taxes[${j}]`));
        return { id: l.id, quantity, gross, allowances, charges, net, taxes };
    });

    const documentAdjustments = (list: readonly DocumentAdjustment[] | undefined, path: string) =>
        (list ?? []).map(
            (a, j): ComputedDocumentAdjustment => ({
                ...adjust(a, `${path}[${j}]`),
                taxes: a.taxes.map((t, k) => tax(t, `${path}[${j}].taxes[${k}]`)),
            }),
        );
    const allowances = documentAdjustments(input.allowances, "allowances");
    const charges = documentAdjustments(input.charges, "charges");

    const groups = new Map<string, Group>();
    const group = (spec: TaxInput): Group => {
        const key = taxKey(spec);
        let g = groups.get(key);
        if (!g) groups.set(key, (g = { spec, taxable: Decimal.ZERO, levy: Decimal.ZERO }));
        return g;
    };
    let residual = Decimal.ZERO;

    if (policy.pricesIncludeTax) {
        if (allowances.length || charges.length) {
            throw new InvoiceError("unsupported", "allowances", "document-level allowances and charges with tax-inclusive prices");
        }
        lines.forEach((line, i) => {
            const [t, ...more] = line.taxes;
            if (!t || more.length || t.compound || t.perUnit !== undefined) {
                throw new InvoiceError("unsupported", `lines[${i}].taxes`, "tax-inclusive prices need exactly one percentage tax per line");
            }
        });
        const byGroup = new Map<Group, ComputedLine[]>();
        for (const line of lines) {
            const g = group(line.taxes[0]!);
            byGroup.set(g, [...(byGroup.get(g) ?? []), line]);
        }
        for (const [g, members] of byGroup) {
            const rate = g.spec.rate === undefined ? Decimal.ZERO : dec(g.spec.rate);
            const extract = (inclusive: Decimal) => inclusive.mul(rate).div(HUNDRED.add(rate), scale, taxMode);
            const inclusive = members.map((l) => l.net);
            const total = Decimal.sum(inclusive);
            if (policy.taxRounding === "line") {
                members.forEach((line, k) => {
                    const t = extract(inclusive[k]!);
                    line.net = inclusive[k]!.sub(t);
                    g.levy = g.levy.add(t);
                });
                g.taxable = Decimal.sum(members.map((l) => l.net));
                continue;
            }
            if (policy.pricesIncludeTax === "extract") {
                g.levy = extract(total);
                g.taxable = total.sub(g.levy);
            } else {
                // BR-CO-17 fixes tax = round(taxable × rate), so not every gross is reachable.
                // Take the taxable amount nearest the exact one that reaches the gross; when
                // none does, the residual goes to BT-114 and the amount due is still the gross.
                const nearest = total.sub(extract(total));
                const unit = ONE.div(dec(10n ** BigInt(scale)), scale, "toward-zero");
                const reaches = (t: Decimal) => t.add(taxOf(t, rate)).eq(total);
                g.taxable = [nearest, nearest.sub(unit), nearest.add(unit)].find(reaches) ?? nearest;
                residual = residual.add(total.sub(g.taxable).sub(taxOf(g.taxable, rate)));
            }
            // Each line's own extraction, then the few units the group-level rounding moved,
            // spread by size. A sale and its return keep opposite nets.
            const nets = inclusive.map((x) => x.sub(extract(x)));
            const moved = allocate(g.taxable.sub(Decimal.sum(nets)), inclusive.map((x) => x.abs()), scale);
            members.forEach((line, k) => (line.net = nets[k]!.add(moved[k]!)));
        }
    } else {
        lines.forEach((line, i) => {
            let levied = Decimal.ZERO;
            for (const spec of line.taxes) {
                if (spec.compound && policy.taxRounding === "document") {
                    throw new InvoiceError("unsupported", `lines[${i}].taxes`, "compound tax under document-level rounding");
                }
                const g = group(spec);
                const base = spec.compound ? line.net.add(levied) : line.net;
                g.taxable = g.taxable.add(base);
                let t = Decimal.ZERO;
                if (spec.perUnit !== undefined) {
                    const exact = line.quantity.mul(dec(spec.perUnit));
                    t = policy.taxRounding === "line" ? exact.round(scale, taxMode) : exact;
                } else if (policy.taxRounding === "line" && spec.rate !== undefined) {
                    t = taxOf(base, dec(spec.rate));
                }
                g.levy = g.levy.add(t);
                levied = levied.add(t);
            }
        });
        for (const [list, sign, path] of [
            [allowances, -1, "allowances"],
            [charges, 1, "charges"],
        ] as const) {
            list.forEach((adjustment, j) => {
                const signed = sign < 0 ? adjustment.amount.neg() : adjustment.amount;
                for (const spec of adjustment.taxes) {
                    if (spec.compound || spec.perUnit !== undefined) {
                        throw new InvoiceError("unsupported", `${path}[${j}].taxes`, "compound or per-unit tax on a document-level adjustment");
                    }
                    const g = group(spec);
                    g.taxable = g.taxable.add(signed);
                    if (policy.taxRounding === "line" && spec.rate !== undefined) g.levy = g.levy.add(taxOf(signed, dec(spec.rate)));
                }
            });
        }
    }

    const taxes: TaxSubtotal[] = [...groups.values()].map(({ spec, taxable, levy }) => {
        let t: Decimal;
        if (policy.taxRounding === "line" || policy.pricesIncludeTax === "extract") t = levy;
        else if (spec.perUnit !== undefined) t = levy.round(scale, taxMode);
        else if (spec.rate !== undefined) t = taxOf(taxable, dec(spec.rate));
        else t = Decimal.ZERO;
        return {
            scheme: spec.scheme ?? "VAT",
            category: spec.category,
            ...(spec.rate !== undefined && { rate: dec(spec.rate) }),
            ...(spec.perUnit !== undefined && { perUnit: dec(spec.perUnit) }),
            taxable: taxable.round(scale, "toward-zero"),
            tax: t.round(scale, "toward-zero"),
            ...(spec.exemptionReason !== undefined && { exemptionReason: spec.exemptionReason }),
            ...(spec.exemptionReasonCode !== undefined && { exemptionReasonCode: spec.exemptionReasonCode }),
        };
    });

    const lineNet = Decimal.sum(lines.map((l) => l.net));
    const allowanceTotal = sumOf(allowances);
    const chargeTotal = sumOf(charges);
    const taxExclusive = lineNet.sub(allowanceTotal).add(chargeTotal);
    const taxTotal = Decimal.sum(taxes.map((t) => t.tax));
    const taxInclusive = taxExclusive.add(taxTotal);
    const prepaid = input.prepaid === undefined ? Decimal.ZERO : amount(input.prepaid, "prepaid");
    const due = taxInclusive.sub(prepaid).add(residual);

    let rounding: Decimal;
    if (input.roundingAmount !== undefined) {
        if (!residual.isZero()) {
            throw new InvoiceError(
                "rounding-conflict",
                "roundingAmount",
                `the reconciled tax already needs ${residual} in BT-114 to keep the shelf price`,
            );
        }
        rounding = amount(input.roundingAmount, "roundingAmount");
    } else if (policy.cashIncrement !== undefined) {
        rounding = due.roundTo(dec(policy.cashIncrement), amountMode).sub(due).add(residual);
    } else {
        rounding = residual;
    }
    // Every figure is already a whole number of minor units; this only fixes the printed scale.
    const at = (d: Decimal) => d.round(scale, "toward-zero");

    return {
        policy: { ...policy, rounding: { ...policy.rounding } },
        core: CORE,
        currency: input.currency,
        scale,
        lines,
        allowances,
        charges,
        taxes,
        totals: {
            lineNet: at(lineNet),
            allowances: at(allowanceTotal),
            charges: at(chargeTotal),
            taxExclusive: at(taxExclusive),
            tax: at(taxTotal),
            taxInclusive: at(taxInclusive),
            prepaid: at(prepaid),
            rounding: at(rounding),
            payable: at(taxInclusive.sub(prepaid).add(rounding)),
        },
    };
}

/** Taxes group by scheme, category and rate (or per-unit amount): "25.0" and "25" are one group. */
export function taxKey(spec: TaxInput): string {
    const norm = (v: string | undefined) => (v === undefined ? "" : dec(v).normalize().toString());
    return [spec.scheme ?? "VAT", spec.category, norm(spec.rate), norm(spec.perUnit)].join("\u0000");
}

function sumOf(items: readonly { amount: Decimal }[]): Decimal {
    return Decimal.sum(items.map((i) => i.amount));
}
