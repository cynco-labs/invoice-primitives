/**
 * An issued document as the strings a person reads, in a locale. Renderers
 * (HTML, PDF, email, a React component) take this view and never format money
 * themselves, so every surface shows the same figures.
 */
import { balance } from "../document/balance.ts";
import type { IssuedState, Party, VoidState } from "../document/types.ts";

export interface View {
    title: string;
    number: string;
    issueDate: string;
    dueDate: string;
    seller: PartyView;
    buyer: PartyView;
    lines: { name: string; description?: string; quantity: string; unit?: string; price: string; net: string; tax: string }[];
    taxes: { label: string; taxable: string; tax: string }[];
    totals: { label: string; amount: string; strong?: boolean }[];
    status: string;
    note?: string;
    corrects?: string;
}

export interface PartyView {
    name: string;
    lines: string[];
}

export function present(doc: IssuedState | VoidState, options: { locale: string; asOf: string }): View {
    const { locale } = options;
    const { currency } = doc.data;
    const { scale, totals } = doc.figures;
    const money = new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        minimumFractionDigits: scale,
        maximumFractionDigits: scale,
    });
    const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 20 });
    const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" });
    const m = (amount: string) => money.format(amount as Intl.StringNumericLiteral);
    const d = (iso: string) => date.format(new Date(`${iso}T00:00:00Z`));
    const rate = (r?: string, perUnit?: string) => (r !== undefined ? `${number.format(r as Intl.StringNumericLiteral)}%` : perUnit !== undefined ? `${m(perUnit)}/unit` : "");

    const owing = doc.status === "issued" ? balance(doc, options.asOf) : undefined;
    const status =
        doc.status === "void"
            ? "Void"
            : owing!.status === "settled"
              ? "Paid"
              : owing!.overdue
                ? `Overdue by ${owing!.daysOverdue} day${owing!.daysOverdue === 1 ? "" : "s"}`
                : owing!.status === "partial"
                  ? "Partly paid"
                  : `Due ${d(doc.dueDate)}`;

    return {
        title: doc.data.kind === "invoice" ? "Invoice" : "Credit note",
        number: doc.number,
        issueDate: d(doc.issueDate),
        dueDate: d(doc.dueDate),
        seller: party(doc.data.seller),
        buyer: party(doc.data.buyer),
        lines: doc.data.lines.map((l, i) => ({
            name: l.name,
            ...(l.description !== undefined && { description: l.description }),
            quantity: number.format(l.quantity as Intl.StringNumericLiteral),
            ...(l.unit !== undefined && { unit: l.unit }),
            price: m(l.price),
            net: m(doc.figures.lines[i]!.net),
            tax: l.taxes.map((t) => [t.category, rate(t.rate, t.perUnit)].filter(Boolean).join(" ")).join(", "),
        })),
        taxes: doc.figures.taxes.map((t) => ({
            label: [t.scheme === "VAT" ? "Tax" : t.scheme, t.category, rate(t.rate, t.perUnit)].join(" "),
            taxable: m(t.taxable),
            tax: m(t.tax),
        })),
        totals: [
            { label: "Subtotal", amount: m(totals.lineNet) },
            ...(totals.allowances !== zero(totals.allowances) ? [{ label: "Discounts", amount: m(`-${totals.allowances}`) }] : []),
            ...(totals.charges !== zero(totals.charges) ? [{ label: "Charges", amount: m(totals.charges) }] : []),
            { label: "Tax", amount: m(totals.tax) },
            ...(totals.rounding !== zero(totals.rounding) ? [{ label: "Rounding", amount: m(totals.rounding) }] : []),
            { label: "Total", amount: m(totals.payable), strong: true },
            ...(owing && owing.settled !== zero(owing.settled) ? [{ label: "Paid", amount: m(`-${owing.settled}`) }] : []),
            ...(owing ? [{ label: "Amount due", amount: m(owing.outstanding), strong: true }] : []),
        ],
        status,
        ...(doc.data.note !== undefined && { note: doc.data.note }),
        ...(doc.data.corrects !== undefined && { corrects: doc.data.corrects }),
    };
}

function party(p: Party): PartyView {
    const a = p.address;
    return {
        name: p.name,
        lines: [
            ...(a ? [...a.lines, [a.postalCode, a.city].filter(Boolean).join(" "), [a.region, a.country].filter(Boolean).join(", ")] : []),
            ...(p.ids ?? []).map((id) => `${id.scheme} ${id.value}`),
            ...(p.email ? [p.email] : []),
        ].filter(Boolean),
    };
}

/** "0.00" at the same scale as `amount`. */
function zero(amount: string): string {
    return amount.replace(/^-/, "").replace(/\d/g, "0");
}
