/**
 * A self-contained HTML rendering of a view: inline styles, no scripts, safe
 * to email or print. Every value is escaped.
 */
import type { PartyView, View } from "./present.ts";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function renderHtml(view: View): string {
    const party = (label: string, p: PartyView) =>
        `<div><div style="color:#6b7280;font-size:12px">${label}</div><strong>${esc(p.name)}</strong>${p.lines.map((l) => `<div>${esc(l)}</div>`).join("")}</div>`;
    const cell = "padding:8px 0;border-bottom:1px solid #e5e7eb";
    const num = `${cell};text-align:right;font-variant-numeric:tabular-nums`;
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(view.title)} ${esc(view.number)}</title></head>
<body style="font-family:system-ui,sans-serif;color:#111827;max-width:720px;margin:40px auto;padding:0 16px;font-size:14px">
<div style="display:flex;justify-content:space-between;align-items:baseline"><h1 style="margin:0;font-size:24px">${esc(view.title)} ${esc(view.number)}</h1><span>${esc(view.status)}</span></div>
<p style="color:#6b7280">Issued ${esc(view.issueDate)} · Due ${esc(view.dueDate)}${view.corrects ? ` · Corrects ${esc(view.corrects)}` : ""}</p>
<div style="display:flex;gap:48px;margin:24px 0">${party("From", view.seller)}${party("To", view.buyer)}</div>
<table style="width:100%;border-collapse:collapse">
<thead><tr><th style="${cell};text-align:left">Item</th><th style="${num}">Qty</th><th style="${num}">Price</th><th style="${num}">Tax</th><th style="${num}">Amount</th></tr></thead>
<tbody>${view.lines
        .map(
            (l) =>
                `<tr><td style="${cell}">${esc(l.name)}${l.description ? `<div style="color:#6b7280">${esc(l.description)}</div>` : ""}</td><td style="${num}">${esc(l.quantity)}${l.unit ? ` ${esc(l.unit)}` : ""}</td><td style="${num}">${esc(l.price)}</td><td style="${num}">${esc(l.tax)}</td><td style="${num}">${esc(l.net)}</td></tr>`,
        )
        .join("")}</tbody></table>
<table style="margin-left:auto;margin-top:16px;min-width:280px;border-collapse:collapse">${view.totals
        .map((t) => `<tr${t.strong ? ' style="font-weight:600"' : ""}><td style="padding:4px 16px 4px 0">${esc(t.label)}</td><td style="text-align:right;font-variant-numeric:tabular-nums">${esc(t.amount)}</td></tr>`)
        .join("")}</table>
${view.taxes.length ? `<p style="color:#6b7280;margin-top:24px">${view.taxes.map((t) => `${esc(t.label)}: ${esc(t.tax)} on ${esc(t.taxable)}`).join(" · ")}</p>` : ""}
${view.note ? `<p>${esc(view.note)}</p>` : ""}
</body></html>`;
}
