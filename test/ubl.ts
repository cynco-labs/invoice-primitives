/**
 * Reads a UBL 2.1 Invoice or CreditNote into the core's input, plus the totals
 * the document states, so the corpus test can recompute and compare.
 */
import { XMLParser } from "fast-xml-parser";
import type { DocumentAdjustment, InvoiceInput, LineInput, TaxInput } from "../src/model.ts";

type Node = Record<string, unknown>;

const parser = new XMLParser({
    removeNSPrefix: true,
    ignoreAttributes: true,
    parseTagValue: false,
    isArray: (name) => ["InvoiceLine", "CreditNoteLine", "AllowanceCharge", "TaxTotal", "TaxSubtotal"].includes(name),
});

const text = (node: unknown, ...path: string[]): string | undefined => {
    let cur: unknown = node;
    for (const key of path) {
        if (cur === null || typeof cur !== "object") return undefined;
        cur = (cur as Node)[key];
    }
    return typeof cur === "string" ? cur.trim() : undefined;
};
const list = (node: unknown, key: string): Node[] => ((node as Node | undefined)?.[key] as Node[] | undefined) ?? [];
const opt = <K extends string>(key: K, value: string | undefined) =>
    (value === undefined ? {} : { [key]: value }) as Partial<Record<K, string>>;

/** xsd:boolean: "true", "1", "false", "0". */
const isCharge = (ac: Node) => ["true", "1"].includes(text(ac, "ChargeIndicator") ?? "");

const tax = (cat: unknown): TaxInput => ({
    category: text(cat, "ID") ?? "",
    ...opt("scheme", text(cat, "TaxScheme", "ID")),
    ...opt("rate", text(cat, "Percent")),
});

const adjustment = (ac: Node) => ({
    ...opt("amount", text(ac, "Amount")),
    ...opt("base", text(ac, "BaseAmount")),
    ...opt("percent", text(ac, "MultiplierFactorNumeric")),
    ...opt("reason", text(ac, "AllowanceChargeReason")),
});

export interface Stated {
    lines: { id: string; net: string }[];
    taxes: { category: string; rate?: string; taxable: string; tax: string }[];
    totals: Record<string, string | undefined>;
}

export function readUbl(xml: string): { input: InvoiceInput; stated: Stated } {
    const parsed = parser.parse(xml) as Node;
    const root = (parsed.Invoice ?? parsed.CreditNote) as Node;
    const lineNodes = [...list(root, "InvoiceLine"), ...list(root, "CreditNoteLine")];

    const lines: LineInput[] = lineNodes.map((l) => {
        const acs = list(l, "AllowanceCharge");
        return {
            id: text(l, "ID") ?? "",
            quantity: text(l, "InvoicedQuantity") ?? text(l, "CreditedQuantity") ?? "0",
            price: text(l, "Price", "PriceAmount") ?? "0",
            ...opt("baseQuantity", text(l, "Price", "BaseQuantity")),
            allowances: acs.filter((a) => !isCharge(a)).map(adjustment),
            charges: acs.filter(isCharge).map(adjustment),
            taxes: [tax((l.Item as Node)?.ClassifiedTaxCategory)],
        };
    });

    const docAc = list(root, "AllowanceCharge");
    const documentAdjustment = (a: Node): DocumentAdjustment => ({ ...adjustment(a), taxes: [tax(a.TaxCategory)] });
    const total = root.LegalMonetaryTotal as Node;
    const taxTotal = list(root, "TaxTotal").find((t) => list(t, "TaxSubtotal").length) ?? {};

    return {
        input: {
            currency: text(root, "DocumentCurrencyCode") ?? "",
            lines,
            allowances: docAc.filter((a) => !isCharge(a)).map(documentAdjustment),
            charges: docAc.filter(isCharge).map(documentAdjustment),
            ...opt("prepaid", text(total, "PrepaidAmount")),
            ...opt("roundingAmount", text(total, "PayableRoundingAmount")),
        },
        stated: {
            lines: lineNodes.map((l) => ({ id: text(l, "ID") ?? "", net: text(l, "LineExtensionAmount") ?? "" })),
            taxes: list(taxTotal, "TaxSubtotal").map((s) => ({
                category: text(s, "TaxCategory", "ID") ?? "",
                ...opt("rate", text(s, "TaxCategory", "Percent")),
                taxable: text(s, "TaxableAmount") ?? "",
                tax: text(s, "TaxAmount") ?? "",
            })),
            totals: {
                lineNet: text(total, "LineExtensionAmount"),
                allowances: text(total, "AllowanceTotalAmount"),
                charges: text(total, "ChargeTotalAmount"),
                taxExclusive: text(total, "TaxExclusiveAmount"),
                tax: text(taxTotal, "TaxAmount"),
                taxInclusive: text(total, "TaxInclusiveAmount"),
                prepaid: text(total, "PrepaidAmount"),
                rounding: text(total, "PayableRoundingAmount"),
                payable: text(total, "PayableAmount"),
            },
        },
    };
}
