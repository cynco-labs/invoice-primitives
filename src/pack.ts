/**
 * A country pack: everything the core needs to know about a jurisdiction, as
 * data. The core computes; a pack supplies the policy, the tax categories, the
 * rules a valid document meets, and when an issued document may be voided.
 */
import type { Issued } from "./lifecycle.ts";
import type { Policy } from "./model.ts";

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
    check(issued: Issued): boolean;
}

export type VoidDecision = { allowed: true } | { allowed: false; reason: string };

export interface CountryPack {
    /** ISO 3166-1 alpha-2, or a supranational code (EU). */
    id: string;
    policies: Readonly<Record<string, Policy>>;
    taxCategories: Readonly<Record<string, TaxCategory>>;
    rules: readonly Rule[];
    canVoid(issued: Issued, now: Date, context: { validatedAt?: Date }): VoidDecision;
}

export interface RuleFailure {
    id: string;
    message: string;
    source: string;
}

export function checkRules(pack: CountryPack, issued: Issued): RuleFailure[] {
    return pack.rules.filter((r) => !r.check(issued)).map(({ id, message, source }) => ({ id, message, source }));
}
