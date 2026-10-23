import type { RoundingMode } from "../decimal.ts";
import type { CountryPack } from "../pack.ts";
import type { Policy } from "../model.ts";

/**
 * Japan's qualified invoice system: consumption tax rounded once per rate per
 * invoice. The business chooses how fractions of a yen round, so the policy
 * takes the mode and names it in its id.
 */
export function jpPolicy(mode: RoundingMode, inclusive = false): Policy {
    return {
        id: `jp-qualified@1/${mode}${inclusive ? "/inclusive" : ""}`,
        taxRounding: "document",
        mode,
        pricesIncludeTax: inclusive && "extract",
    };
}

export const jp: CountryPack = {
    id: "JP",
    policies: { floor: jpPolicy("floor"), floorInclusive: jpPolicy("floor", true) },
    taxCategories: {
        S: { label: "Standard rate (10%)", levies: true },
        AA: { label: "Reduced rate (8%)", levies: true },
        E: { label: "Exempt", levies: false },
        O: { label: "Outside scope", levies: false },
    },
    rules: [],
    canVoid: () => ({ allowed: false, reason: "issue a return invoice (適格返還請求書)" }),
};
