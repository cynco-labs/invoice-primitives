import type { RoundingMode } from "../money/decimal.ts";
import type { CountryPack } from "../pack.ts";
import type { Policy } from "../calc/model.ts";

const JP_RATES = "https://stripe.com/resources/more/how-to-calculate-consumption-tax-under-the-japanese-invoice-system";

/**
 * Japan's qualified invoice system: consumption tax rounded once per rate per
 * invoice. The business chooses how fractions of a yen of tax round, so the
 * policy takes that mode and names it in its id. Other amounts round half up.
 */
export function jpPolicy(taxMode: RoundingMode, inclusive = false): Policy {
    return {
        id: `jp-qualified@1/${taxMode}${inclusive ? "/inclusive" : ""}`,
        taxRounding: "document",
        rounding: { amounts: "half-away-from-zero", tax: taxMode },
        pricesIncludeTax: inclusive && "extract",
    };
}

/**
 * 切り捨て (rounding down) is read as truncation toward zero: the same as floor
 * on a sale, and it keeps a return's tax symmetric. An assumption, not sourced.
 */
export const jp: CountryPack = {
    id: "JP",
    policies: { truncate: jpPolicy("toward-zero"), truncateInclusive: jpPolicy("toward-zero", true) },
    taxCategories: {
        S: { label: "Standard rate (10%)", levies: true },
        AA: { label: "Reduced rate (8%)", levies: true },
        E: { label: "Exempt", levies: false },
        O: { label: "Outside scope", levies: false },
    },
    rules: [],
    defaults: { policy: "truncate", currency: "JPY", timeZone: "Asia/Tokyo" },
    taxes: {
        "standard-10": { label: "Standard rate 10%", taxes: [{ category: "S", rate: "10" }], source: JP_RATES, checked: "2026-10-23" },
        "reduced-8": { label: "Reduced rate 8% (food, newspapers)", taxes: [{ category: "AA", rate: "8" }], source: JP_RATES, checked: "2026-10-23" },
        exempt: { label: "Exempt", taxes: [{ category: "E" }], source: JP_RATES, checked: "2026-10-23" },
        "outside-scope": { label: "Outside the scope of tax", taxes: [{ category: "O" }], source: JP_RATES, checked: "2026-10-23" },
    },
    canVoid: () => ({ allowed: false, reason: "issue a return invoice (適格返還請求書)" }),
};
