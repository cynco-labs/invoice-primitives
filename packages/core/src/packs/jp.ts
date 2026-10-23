import type { RoundingMode } from "../money/decimal.ts";
import type { CountryPack } from "../pack.ts";
import type { Policy } from "../calc/model.ts";

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
    canVoid: () => ({ allowed: false, reason: "issue a return invoice (適格返還請求書)" }),
};
