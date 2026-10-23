/**
 * A country pack: what the core needs to know about a jurisdiction, as JSON.
 * The core computes; a pack supplies the policies, the tax categories, the
 * named taxes, the rules an issued document meets, and when an issued document
 * may be voided. Being data, a pack can be passed to any backend, stored, or
 * read by an implementation in another language.
 */
import type { Policy } from "./calc/model.ts";
import type { DraftData, Figures } from "./document/types.ts";
import { InvoiceError } from "./errors.ts";
import { isObject } from "./json.ts";
import { bundledPacks } from "./packs/index.ts";
import { parse, type Infer } from "./schema/dsl.ts";
import * as S from "./schema/shapes.ts";

export type CountryPack = Infer<typeof S.CountryPack>;
export type TaxCategory = Infer<typeof S.TaxCategory>;
export type NamedTax = Infer<typeof S.NamedTax>;
export type Rule = Infer<typeof S.Rule>;
export type RuleCheck = Infer<typeof S.RuleCheck>;
export type Voiding = Infer<typeof S.Voiding>;

export type VoidDecision = { allowed: true } | { allowed: false; reason: string };

/** Policy ids resolved to their policy and the pack that publishes it; countries to their pack. */
export interface Registry {
    resolve(policyId: string): { policy: Policy; pack: CountryPack };
    country(id: string): CountryPack;
}

let bundled: Registry | undefined;
const custom = new Map<string, Registry>();

/**
 * The registry for `packs`, or the bundled ones, built once: backends that
 * receive packs with every call (Convex, a Durable Object) check them once.
 */
export function registryFor(packs: readonly CountryPack[] | undefined): Registry {
    if (packs === undefined) return (bundled ??= createRegistry(bundledPacks));
    const key = JSON.stringify(packs);
    let registry = custom.get(key);
    if (!registry) {
        registry = createRegistry(packs);
        if (custom.size >= 16) custom.delete(custom.keys().next().value!);
        custom.set(key, registry);
    }
    return registry;
}

/** Checks every pack (its shape, categories and rule paths) and indexes it. */
export function createRegistry(packs: readonly CountryPack[]): Registry {
    const byId = new Map<string, { policy: Policy; pack: CountryPack }>();
    const countries = new Map<string, CountryPack>();
    packs.forEach((given, i) => {
        const at = `packs[${i}]`;
        const pack = parse(S.CountryPack, given, at);
        if (countries.has(pack.id)) throw new InvoiceError("invalid-argument", `${at}.id`, `two packs for ${pack.id}`);
        if (!Object.hasOwn(pack.policies, pack.defaults.policy)) {
            throw new InvoiceError("invalid-argument", `${at}.defaults.policy`, `${pack.defaults.policy} is not one of the pack's policies`);
        }
        for (const [name, tax] of Object.entries(pack.taxes)) {
            tax.taxes.forEach((t, k) => {
                if (!Object.hasOwn(pack.taxCategories, t.category)) {
                    throw new InvoiceError("invalid-tax", `${at}.taxes.${name}.taxes[${k}].category`, `${pack.id} has no tax category ${t.category}`);
                }
            });
        }
        pack.rules.forEach((rule, j) => {
            const [field, path] = pathOf(rule.check);
            steps(path, `${at}.rules[${j}].check.${field}`);
            if ("match" in rule.check) pattern(rule.check.pattern, `${at}.rules[${j}].check.pattern`);
        });
        countries.set(pack.id, pack);
        for (const policy of Object.values(pack.policies)) {
            if (byId.has(policy.id)) throw new InvoiceError("invalid-argument", `${at}.policies`, `policy id ${policy.id} is published twice`);
            byId.set(policy.id, { policy, pack });
        }
    });
    return {
        country(id) {
            const pack = countries.get(id);
            if (!pack) throw new InvoiceError("invalid-argument", "country", `no registered pack for ${id}; packs: ${[...countries.keys()].join(", ")}`);
            return pack;
        },
        resolve(policyId) {
            const found = byId.get(policyId);
            if (!found) throw new InvoiceError("unknown-policy", "data.policy", `no registered pack publishes policy ${policyId}`);
            return found;
        },
    };
}

/** The field of a rule check that holds its path, and the path. */
function pathOf(check: RuleCheck): [field: string, path: string] {
    if ("require" in check) return ["require", check.require];
    if ("match" in check) return ["match", check.match];
    return ["oneOf", check.oneOf];
}

/** `validatedAt`: when a clearance authority accepted the document, if one did. */
export function canVoid(voiding: Voiding, now: string, validatedAt?: string): VoidDecision {
    if (voiding.allowed === true) return { allowed: true };
    if (voiding.allowed === false) return { allowed: false, reason: voiding.reason };
    if (validatedAt === undefined) return { allowed: true };
    const hours = (Date.parse(now) - Date.parse(validatedAt)) / 3_600_000;
    return hours <= voiding.hours ? { allowed: true } : { allowed: false, reason: voiding.reason };
}

/** The rules an issued document fails. */
export function failedRules(rules: readonly Rule[], document: { data: DraftData; figures: Figures }): Rule[] {
    return rules.filter((rule) => !holds(rule.check, document));
}

function holds(check: RuleCheck, document: { data: DraftData; figures: Figures }): boolean {
    const [, path] = pathOf(check);
    const values = valuesAt(document, path);
    if ("require" in check) return values.some(present);
    const textual = (v: unknown): v is string | number => typeof v === "string" || typeof v === "number";
    if ("match" in check) {
        const re = pattern(check.pattern, "pattern");
        return values.every((v) => textual(v) && re.test(String(v)));
    }
    return values.every((v) => textual(v) && check.values.includes(String(v)));
}

/** A value a rule can count as given: not blank, not an empty list or object. */
function present(v: unknown): boolean {
    if (typeof v === "string") return v.trim() !== "";
    if (typeof v === "number" || typeof v === "boolean") return true;
    if (Array.isArray(v)) return v.length > 0;
    return isObject(v) && Object.keys(v).length > 0;
}

function pattern(source: string, path: string): RegExp {
    try {
        return new RegExp(`^(?:${source})$`, "u");
    } catch {
        throw new InvoiceError("invalid-argument", path, `${source} is not a regular expression`);
    }
}

interface Step {
    key: string;
    /** `[]`: every element of a list; `[key=value]`: those whose `key` reads `value`. */
    list?: { key: string; value: string } | "all";
}

const STEP = /([A-Za-z][\w-]*)(\[(?:([A-Za-z][\w-]*)=([^\]]*))?\])?(\.|$)/y;

/** The steps of a path into `{ data, figures }`, refusing one that cannot be read. */
function steps(path: string, at: string): Step[] {
    const out: Step[] = [];
    let i = 0;
    while (i < path.length) {
        STEP.lastIndex = i;
        const m = STEP.exec(path);
        if (!m || (m[5] === "." && STEP.lastIndex === path.length)) {
            throw new InvoiceError("invalid-argument", at, `${path} is not a path like data.buyer.ids[scheme=TIN].value`);
        }
        const [, key, list, filterKey, filterValue] = m;
        out.push({ key: key!, ...(list !== undefined && { list: filterKey === undefined ? "all" : { key: filterKey, value: filterValue! } }) });
        i = STEP.lastIndex;
    }
    if (out[0]?.key !== "data" && out[0]?.key !== "figures") throw new InvoiceError("invalid-argument", at, `${path} starts at data or figures`);
    return out;
}

/**
 * The values at a path like `data.buyer.ids[scheme=TIN].value`. `[]` visits
 * every element of a list; `[key=value]` only those whose `key` reads `value`.
 */
export function valuesAt(root: unknown, path: string): unknown[] {
    let values: unknown[] = [root];
    for (const { key, list } of steps(path, "path")) {
        values = values.flatMap((v) => {
            const next = isObject(v) && Object.hasOwn(v, key) ? v[key] : undefined;
            if (list === undefined) return next === undefined ? [] : [next];
            if (!Array.isArray(next)) return [];
            if (list === "all") return next;
            return next.filter((e: unknown) => isObject(e) && Object.hasOwn(e, list.key) && String(e[list.key]) === list.value);
        });
    }
    return values;
}
