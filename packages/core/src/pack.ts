/**
 * A country pack: what the core needs to know about a jurisdiction, as data.
 * The core computes; a pack supplies the policies, the tax categories, the
 * rules an issued document meets, and when an issued document may be voided.
 */
import type { Policy } from "./calc/model.ts";
import type { DraftData, Figures, IssuedState } from "./document/types.ts";
import { InvoiceError } from "./errors.ts";

export interface TaxCategory {
    label: string;
    /** Whether the category levies tax at a rate (S) or not at all (E, Z, O). */
    levies: boolean;
}

export interface Rule {
    id: string;
    message: string;
    /** Where the rule is written down. */
    source: string;
    check(document: { data: DraftData; figures: Figures }): boolean;
}

export type VoidDecision = { allowed: true } | { allowed: false; reason: string };

export interface CountryPack {
    /** ISO 3166-1 alpha-2, or a supranational code (EU). */
    id: string;
    policies: Readonly<Record<string, Policy>>;
    /** Every tax category a line may carry under this pack's policies. */
    taxCategories: Readonly<Record<string, TaxCategory>>;
    rules: readonly Rule[];
    /** `validatedAt`: when a clearance authority accepted the document, if one did. */
    canVoid(document: IssuedState, now: string, context: { validatedAt?: string }): VoidDecision;
}

/** Policy ids resolved to their policy and the pack that publishes it. */
export interface Registry {
    resolve(policyId: string): { policy: Policy; pack: CountryPack };
}

export function createRegistry(packs: readonly CountryPack[]): Registry {
    const byId = new Map<string, { policy: Policy; pack: CountryPack }>();
    for (const pack of packs) {
        for (const policy of Object.values(pack.policies)) {
            if (byId.has(policy.id)) throw new Error(`policy id ${policy.id} is published twice`);
            byId.set(policy.id, { policy, pack });
        }
    }
    return {
        resolve(policyId) {
            const found = byId.get(policyId);
            if (!found) throw new InvoiceError("unknown-policy", "data.policy", `no registered pack publishes policy ${policyId}`);
            return found;
        },
    };
}
