/**
 * A self-contained HTML rendering of a view: inline styles, no scripts, safe
 * to email or print. Every value is escaped. For a design of your own, render
 * the view yourself: it already holds every string, formatted.
 */
import type { PartyView, View } from "./present.ts";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface Brand {
    /** An https URL or data URI, shown above the title. */
    logoUrl?: string;
    /** A hex colour for the title and totals rule ("#0f766e"). */
    accent?: string;
    /** Printed at the bottom: bank details, registration, thanks. */
    footer?: string;
    /** Labels for the item table. */
    columns?: { item: string; quantity: string; price: string; tax: string; amount: string };
    from?: string;
    to?: string;
    issued?: string;
    due?: string;
    corrects?: string;
}

const HEX = /^#[0-9a-f]{3,8}$/i;
const SAFE_URL = /^(https:|data:image\/)/i;

export function renderHtml(view: View, brand: Brand = {}): string {
    const accent = brand.accent && HEX.test(brand.accent) ? brand.accent : "#111827";
    const cols = brand.columns ?? { item: "Item", quantity: "Qty", price: "Price", tax: "Tax", amount: "Amount" };
    const logo = brand.logoUrl && SAFE_URL.test(brand.logoUrl) ? `<img src="${esc(brand.logoUrl)}" alt="" style="max-height:48px;margin-bottom:16px">` : "";
    const party = (label: string, p: PartyView) =>
        `<div><div style="color:#6b7280;font-size:12px">${label}</div><strong>${esc(p.name)}</strong>${p.lines.map((l) => `<div>${esc(l)}</div>`).join("")}</div>`;
    const cell = "padding:8px 0;border-bottom:1px solid #e5e7eb";
    const num = `${cell};text-align:right;font-variant-numeric:tabular-nums`;
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(view.title)} ${esc(view.number)}</title></head>
<body style="font-family:system-ui,sans-serif;color:#111827;max-width:720px;margin:40px auto;padding:0 16px;font-size:14px">
${logo}<div style="display:flex;justify-content:space-between;align-items:baseline"><h1 style="margin:0;font-size:24px;color:${accent}">${esc(view.title)} ${esc(view.number)}</h1><span>${esc(view.status)}</span></div>
<p style="color:#6b7280">${esc(brand.issued ?? "Issued")} ${esc(view.issueDate)} · ${esc(brand.due ?? "Due")} ${esc(view.dueDate)}${view.corrects ? ` · ${esc(brand.corrects ?? "Corrects")} ${esc(view.corrects)}` : ""}</p>
<div style="display:flex;gap:48px;margin:24px 0">${party(brand.from ?? "From", view.seller)}${party(brand.to ?? "To", view.buyer)}</div>
<table style="width:100%;border-collapse:collapse">
<thead><tr><th style="${cell};text-align:left">${esc(cols.item)}</th><th style="${num}">${esc(cols.quantity)}</th><th style="${num}">${esc(cols.price)}</th><th style="${num}">${esc(cols.tax)}</th><th style="${num}">${esc(cols.amount)}</th></tr></thead>
<tbody>${view.lines
        .map(
            (l) =>
                `<tr><td style="${cell}">${esc(l.name)}${l.description ? `<div style="color:#6b7280">${esc(l.description)}</div>` : ""}</td><td style="${num}">${esc(l.quantity)}${l.unit ? ` ${esc(l.unit)}` : ""}</td><td style="${num}">${esc(l.price)}</td><td style="${num}">${esc(l.tax)}</td><td style="${num}">${esc(l.net)}</td></tr>`,
        )
        .join("")}</tbody></table>
<table style="margin-left:auto;margin-top:16px;min-width:280px;border-collapse:collapse;border-top:2px solid ${accent}">${view.totals
        .map((t) => `<tr${t.strong ? ' style="font-weight:600"' : ""}><td style="padding:4px 16px 4px 0">${esc(t.label)}</td><td style="text-align:right;font-variant-numeric:tabular-nums">${esc(t.amount)}</td></tr>`)
        .join("")}</table>
${view.taxes.length ? `<p style="color:#6b7280;margin-top:24px">${view.taxes.map((t) => `${esc(t.label)}: ${esc(t.tax)} on ${esc(t.taxable)}`).join(" · ")}</p>` : ""}
${view.note ? `<p>${esc(view.note)}</p>` : ""}
${brand.footer ? `<footer style="margin-top:32px;color:#6b7280;font-size:12px;white-space:pre-line">${esc(brand.footer)}</footer>` : ""}
</body></html>`;
}
