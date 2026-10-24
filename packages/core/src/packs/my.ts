import type { CountryPack } from "../pack.ts";

/** A secondary source (Grant Thornton Malaysia) on the SST rates from 1 July 2025; not the Customs order itself. */
const SST_2025 = "https://www.grantthornton.com.my/insights/Tax/revision-of-sales-tax-rates-and-expansion-of-scope-for-service-tax/";
const PINT_MY = "https://docs.peppol.eu/poac/my/pint-my/bis/";
const HALF_UP = { amounts: "half-away-from-zero", tax: "half-away-from-zero" } as const;

/**
 * Malaysia. Categories are PINT MY's (https://docs.peppol.eu/poac/my/pint-my/bis/).
 * PINT MY computes tax per category on the document and leaves the 5-sen cash
 * rounding of Bank Negara's directive to the supplier, recorded in BT-114.
 * Neither LHDN nor PINT MY publishes a rounding mode; half away from zero is
 * this pack's assumption.
 */
export const my: CountryPack = {
    id: "MY",
    policies: {
        pint: { id: "my-pint@1", taxRounding: "document", rounding: HALF_UP, pricesIncludeTax: false },
        pintCash: {
            id: "my-pint-cash@1",
            taxRounding: "document",
            rounding: HALF_UP,
            pricesIncludeTax: false,
            cashIncrement: "0.05",
        },
    },
    taxCategories: {
        SA: { label: "Sales Tax", levies: true },
        SE: { label: "Service Tax", levies: true },
        HVG: { label: "High-Value Goods Tax", levies: true },
        LVG: { label: "Sales Tax on Low-Value Goods", levies: true },
        TTX: { label: "Tourism Tax", levies: true },
        E: { label: "Exempt from tax", levies: false },
        O: { label: "Outside scope of tax", levies: false },
    },
    rules: [],
    defaults: { policy: "pint", currency: "MYR", timeZone: "Asia/Kuala_Lumpur" },
    taxes: {
        "sales-10": { label: "Sales tax 10%", taxes: [{ category: "SA", rate: "10" }], source: SST_2025, checked: "2026-10-23" },
        "sales-5": { label: "Sales tax 5%", taxes: [{ category: "SA", rate: "5" }], source: SST_2025, checked: "2026-10-23" },
        "service-8": { label: "Service tax 8%", taxes: [{ category: "SE", rate: "8" }], source: SST_2025, checked: "2026-10-23" },
        "service-6": {
            label: "Service tax 6% (food and beverage, telecommunications, logistics, parking...)",
            taxes: [{ category: "SE", rate: "6" }],
            source: SST_2025,
            checked: "2026-10-23",
        },
        tourism: {
            label: "Tourism tax, RM10 per room per night",
            taxes: [{ category: "TTX", perUnit: "10.00" }],
            source: "https://www.ttgasia.com/2017/07/27/flat-rate-for-tourism-tax-malaysians-exempted/",
            checked: "2026-10-23",
        },
        exempt: { label: "Exempt", taxes: [{ category: "E" }], source: PINT_MY, checked: "2026-10-23" },
        "outside-scope": { label: "Outside the scope of tax", taxes: [{ category: "O" }], source: PINT_MY, checked: "2026-10-23" },
    },
    voiding: { allowed: "within", hours: 72, after: "validation", reason: "MyInvois cancels only within 72 hours of validation; issue a credit note" },
};
