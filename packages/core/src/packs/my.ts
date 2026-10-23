import type { CountryPack } from "../pack.ts";

const HOURS_72 = 72 * 60 * 60 * 1000;
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
    canVoid(_document, now, { validatedAt }) {
        if (!validatedAt) return { allowed: true };
        return Date.parse(now) - Date.parse(validatedAt) <= HOURS_72
            ? { allowed: true }
            : {
                  allowed: false,
                  reason: "MyInvois cancels only within 72 hours of validation; issue a credit note",
              };
    },
};
