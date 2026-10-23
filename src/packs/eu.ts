import type { CountryPack } from "../pack.ts";

/** EN 16931 with the UNCL5305 categories. */
export const eu: CountryPack = {
    id: "EU",
    policies: {
        en16931: { id: "en16931@1", taxRounding: "document", mode: "half-away-from-zero", pricesIncludeTax: false },
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
    canVoid: () => ({ allowed: false, reason: "EN 16931 has no voiding; issue a credit note (document type 381)" }),
};
