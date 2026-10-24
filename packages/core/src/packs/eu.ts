import type { CountryPack } from "../pack.ts";

const UNCL5305 = "https://docs.peppol.eu/poacc/billing/3.0/codelist/UNCL5305/";
const HALF_UP = { amounts: "half-away-from-zero", tax: "half-away-from-zero" } as const;

/** EN 16931 with the UNCL5305 categories. */
export const eu: CountryPack = {
    id: "EU",
    policies: {
        en16931: { id: "en16931@1", taxRounding: "document", rounding: HALF_UP, pricesIncludeTax: false },
    },
    taxCategories: {
        S: { label: "Standard rate", levies: true },
        Z: { label: "Zero rated goods", levies: false },
        E: { label: "Exempt from tax", levies: false },
        AE: { label: "VAT reverse charge", levies: false },
        K: { label: "Intra-community supply", levies: false },
        G: { label: "Free export item, tax not charged", levies: false },
        O: { label: "Services outside scope of tax", levies: false },
        L: { label: "Canary Islands general indirect tax", levies: true },
        M: { label: "Tax for production, services and importation in Ceuta and Melilla", levies: true },
    },
    rules: [],
    // Rates differ by member state, so the EU pack names only the categories that levy nothing.
    defaults: { policy: "en16931" },
    taxes: {
        exempt: { label: "Exempt", taxes: [{ category: "E", rate: "0" }], source: UNCL5305, checked: "2026-10-23" },
        zero: { label: "Zero rated", taxes: [{ category: "Z", rate: "0" }], source: UNCL5305, checked: "2026-10-23" },
        "reverse-charge": { label: "Reverse charge", taxes: [{ category: "AE", rate: "0" }], source: UNCL5305, checked: "2026-10-23" },
        "intra-community": { label: "Intra-community supply", taxes: [{ category: "K", rate: "0" }], source: UNCL5305, checked: "2026-10-23" },
        export: { label: "Export outside the EU", taxes: [{ category: "G", rate: "0" }], source: UNCL5305, checked: "2026-10-23" },
        "outside-scope": { label: "Outside the scope of tax", taxes: [{ category: "O" }], source: UNCL5305, checked: "2026-10-23" },
    },
    voiding: { allowed: false, reason: "EN 16931 has no voiding; issue a credit note (document type 381)" },
};
