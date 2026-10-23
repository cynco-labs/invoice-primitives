/**
 * The calculation: one pure pass from an invoice's inputs to every figure
 * EN 16931 defines (BT-106..BT-117, BT-131), under a rounding policy.
 */
import { allocate } from "./allocate.ts";
import { MINOR_UNITS } from "./currencies.ts";
import { Decimal, dec } from "./decimal.ts";
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

/** A valid input this version of the core does not compute, rather than computing it wrong. */
export class UnsupportedError extends Error {
    override name = "UnsupportedError";
}

export function minorUnits(currency: string): number {
    const units = MINOR_UNITS[currency];
    if (units === undefined) throw new RangeError(`unknown ISO 4217 currency: ${currency}`);
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
    const { mode } = policy;
    const percentOf = (base: Decimal, percent: Decimal) => base.mul(percent).div(HUNDRED, scale, mode);

    /** A stated amount: refused when it has more precision than the currency. */
    const amount = (value: string, field: string): Decimal => {
        const d = dec(value);
        const scaled = d.round(scale, "toward-zero");
        if (!scaled.eq(d)) throw new RangeError(`${field} ${value} has more than ${scale} decimals for ${input.currency}`);
        return scaled;
    };

    const adjust = (a: Adjustment, defaultBase: Decimal, field: string): ComputedAdjustment => {
        const base = a.base === undefined ? undefined : amount(a.base, `${field}.base`);
        const percent = a.percent === undefined ? undefined : dec(a.percent);
        let value: Decimal;
        if (a.amount !== undefined) value = amount(a.amount, `${field}.amount`);
        else if (percent) value = percentOf(base ?? defaultBase, percent);
        else throw new RangeError(`${field} needs an amount or a percent`);
        return {
            amount: value,
            ...(base && { base }),
            ...(percent && { percent }),
            ...(a.reason !== undefined && { reason: a.reason }),
            ...(a.reasonCode !== undefined && { reasonCode: a.reasonCode }),
        };
    };

    const lines: ComputedLine[] = input.lines.map((l, i) => {
        const field = `lines[${i}]`;
        const baseQuantity = l.baseQuantity === undefined ? ONE : dec(l.baseQuantity);
        const quantity = dec(l.quantity);
        const gross = quantity.mul(dec(l.price)).div(baseQuantity, scale, mode);
        const allowances = (l.allowances ?? []).map((a, j) => adjust(a, gross, `${field}.allowances[${j}]`));
        const charges = (l.charges ?? []).map((c, j) => adjust(c, gross, `${field}.charges[${j}]`));
        const net = gross.add(sumOf(charges)).sub(sumOf(allowances));
        return { id: l.id, quantity, gross, allowances, charges, net, taxes: l.taxes };
    });

    const lineNetBeforeTax = sumOf(lines.map((l) => ({ amount: l.net })));
    const documentAdjustments = (list: readonly DocumentAdjustment[] | undefined, field: string) =>
        (list ?? []).map(
            (a, j): ComputedDocumentAdjustment => ({ ...adjust(a, lineNetBeforeTax, `${field}[${j}]`), taxes: a.taxes }),
        );
    const allowances = documentAdjustments(input.allowances, "allowances");
    const charges = documentAdjustments(input.charges, "charges");

    const groups = new Map<string, Group>();
    let residual = Decimal.ZERO;
    const group = (spec: TaxInput): Group => {
        if (spec.rate !== undefined && spec.perUnit !== undefined) {
            throw new RangeError(`tax ${spec.category} has both a rate and a per-unit amount`);
        }
        const key = taxKey(spec);
        let g = groups.get(key);
        if (!g) groups.set(key, (g = { spec, taxable: Decimal.ZERO, levy: Decimal.ZERO }));
        return g;
    };

    if (policy.pricesIncludeTax) {
        if (allowances.length || charges.length) {
            throw new UnsupportedError("document-level allowances and charges with tax-inclusive prices");
        }
        for (const line of lines) {
            const [tax, ...more] = line.taxes;
            if (!tax || more.length || tax.compound || tax.perUnit !== undefined) {
                throw new UnsupportedError(`line ${line.id}: tax-inclusive prices need exactly one percentage tax per line`);
            }
        }
        const byGroup = new Map<Group, ComputedLine[]>();
        for (const line of lines) {
            const g = group(line.taxes[0]!);
            byGroup.set(g, [...(byGroup.get(g) ?? []), line]);
        }
        for (const [g, members] of byGroup) {
            const rate = g.spec.rate === undefined ? Decimal.ZERO : dec(g.spec.rate);
            const extract = (inclusive: Decimal) => inclusive.mul(rate).div(HUNDRED.add(rate), scale, mode);
            if (policy.taxRounding === "line") {
                for (const line of members) {
                    const tax = extract(line.net);
                    line.net = line.net.sub(tax);
                    g.taxable = g.taxable.add(line.net);
                    g.levy = g.levy.add(tax);
                }
            } else if (policy.pricesIncludeTax === "extract") {
                const inclusive = sumOf(members.map((l) => ({ amount: l.net })));
                const tax = extract(inclusive);
                g.taxable = inclusive.sub(tax);
                g.levy = tax;
                const nets = allocate(g.taxable, members.map((l) => l.net), scale);
                members.forEach((line, k) => (line.net = nets[k]!));
            } else {
                // BR-CO-17 fixes tax = round(taxable × rate), so not every gross is reachable.
                // Take the taxable amount nearest the exact one that reaches the gross; when
                // none does, the residual goes to BT-114 and the amount due is still the gross.
                const inclusive = sumOf(members.map((l) => ({ amount: l.net })));
                const nearest = inclusive.sub(extract(inclusive));
                const unit = ONE.div(dec(10n ** BigInt(scale)), scale, mode);
                const reaches = (t: Decimal) => t.add(percentOf(t, rate)).eq(inclusive);
                g.taxable = [nearest, nearest.sub(unit), nearest.add(unit)].find(reaches) ?? nearest;
                residual = residual.add(inclusive.sub(g.taxable).sub(percentOf(g.taxable, rate)));
                const nets = allocate(g.taxable, members.map((l) => l.net), scale);
                members.forEach((line, k) => (line.net = nets[k]!));
            }
        }
    } else {
        for (const line of lines) {
            let levied = Decimal.ZERO;
            for (const spec of line.taxes) {
                if (spec.compound && policy.taxRounding === "document") {
                    throw new UnsupportedError(`line ${line.id}: compound tax under document-level rounding`);
                }
                const g = group(spec);
                const base = spec.compound ? line.net.add(levied) : line.net;
                g.taxable = g.taxable.add(base);
                if (spec.perUnit !== undefined) {
                    const exact = line.quantity.mul(dec(spec.perUnit));
                    const tax = policy.taxRounding === "line" ? exact.round(scale, mode) : exact;
                    g.levy = g.levy.add(tax);
                    levied = levied.add(tax);
                } else if (policy.taxRounding === "line" && spec.rate !== undefined) {
                    const tax = percentOf(base, dec(spec.rate));
                    g.levy = g.levy.add(tax);
                    levied = levied.add(tax);
                }
            }
        }
        for (const [list, sign] of [
            [allowances, -1],
            [charges, 1],
        ] as const) {
            for (const adjustment of list) {
                const signed = sign < 0 ? adjustment.amount.neg() : adjustment.amount;
                for (const spec of adjustment.taxes) {
                    if (spec.compound || spec.perUnit !== undefined) {
                        throw new UnsupportedError("compound or per-unit tax on a document-level allowance or charge");
                    }
                    const g = group(spec);
                    g.taxable = g.taxable.add(signed);
                    if (policy.taxRounding === "line" && spec.rate !== undefined) {
                        g.levy = g.levy.add(percentOf(signed, dec(spec.rate)));
                    }
                }
            }
        }
    }

    const taxes: TaxSubtotal[] = [...groups.values()].map(({ spec, taxable, levy }) => {
        let tax: Decimal;
        if (policy.taxRounding === "line" || policy.pricesIncludeTax === "extract") tax = levy;
        else if (spec.perUnit !== undefined) tax = levy.round(scale, mode);
        else if (spec.rate !== undefined) tax = percentOf(taxable, dec(spec.rate));
        else tax = Decimal.ZERO;
        return {
            scheme: spec.scheme ?? "VAT",
            category: spec.category,
            ...(spec.rate !== undefined && { rate: dec(spec.rate) }),
            ...(spec.perUnit !== undefined && { perUnit: dec(spec.perUnit) }),
            taxable: taxable.round(scale, mode),
            tax: tax.round(scale, mode),
            ...(spec.exemptionReason !== undefined && { exemptionReason: spec.exemptionReason }),
            ...(spec.exemptionReasonCode !== undefined && { exemptionReasonCode: spec.exemptionReasonCode }),
        };
    });

    const lineNet = sumOf(lines.map((l) => ({ amount: l.net })));
    const allowanceTotal = sumOf(allowances);
    const chargeTotal = sumOf(charges);
    const taxExclusive = lineNet.sub(allowanceTotal).add(chargeTotal);
    const taxTotal = sumOf(taxes.map((t) => ({ amount: t.tax })));
    const taxInclusive = taxExclusive.add(taxTotal);
    const prepaid = input.prepaid === undefined ? Decimal.ZERO : amount(input.prepaid, "prepaid");
    const due = taxInclusive.sub(prepaid).add(residual);
    const rounding =
        input.roundingAmount !== undefined
            ? amount(input.roundingAmount, "roundingAmount")
            : policy.cashIncrement !== undefined
              ? due.roundTo(dec(policy.cashIncrement), mode).sub(due).add(residual)
              : residual;
    const at = (d: Decimal) => d.round(scale, mode);

    return {
        policy,
        currency: input.currency,
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
