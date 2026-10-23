import type { ComputedInvoice } from "../calc/model.ts";
import type { Figures } from "./types.ts";

/** The computed figures as the strings an issued document keeps forever. */
export function toFigures(c: ComputedInvoice): Figures {
    const s = (d: { toString(): string }) => d.toString();
    return {
        policy: c.policy.id,
        core: c.core,
        scale: c.scale,
        lines: c.lines.map((l) => ({ id: l.id, net: s(l.net) })),
        taxes: c.taxes.map((t) => ({
            scheme: t.scheme,
            category: t.category,
            ...(t.rate && { rate: s(t.rate) }),
            ...(t.perUnit && { perUnit: s(t.perUnit) }),
            taxable: s(t.taxable),
            tax: s(t.tax),
            ...(t.exemptionReason !== undefined && { exemptionReason: t.exemptionReason }),
            ...(t.exemptionReasonCode !== undefined && { exemptionReasonCode: t.exemptionReasonCode }),
        })),
        totals: {
            lineNet: s(c.totals.lineNet),
            allowances: s(c.totals.allowances),
            charges: s(c.totals.charges),
            taxExclusive: s(c.totals.taxExclusive),
            tax: s(c.totals.tax),
            taxInclusive: s(c.totals.taxInclusive),
            prepaid: s(c.totals.prepaid),
            rounding: s(c.totals.rounding),
            payable: s(c.totals.payable),
        },
    };
}
