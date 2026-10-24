/**
 * Shapes as data. One definition per JSON shape gives its TypeScript type
 * (`Infer`), its runtime check (`parse`), its JSON Schema (`jsonSchema`), and,
 * through `scripts/gen-schema.ts`, the Convex validators, so none of them can
 * disagree with another.
 *
 * Small on purpose: the shapes here are plain JSON, so strings, numbers,
 * booleans, literals, lists, records, objects and unions cover them.
 */
import { MINOR_UNITS } from "../money/currencies.ts";
import { DECIMAL } from "../money/decimal.ts";
import { InvoiceError } from "../errors.ts";
import { isDate, isTimeZone } from "../document/dates.ts";
import { isObject } from "../json.ts";

export type Node =
    | { kind: "string"; format?: "text" | "decimal" | "date" | "currency" | "timeZone" }
    | { kind: "number"; integer?: boolean; min?: number; max?: number }
    | { kind: "boolean" }
    | { kind: "literal"; value: string | number | boolean }
    | { kind: "array"; item: Node }
    | { kind: "record"; value: Node }
    | { kind: "object"; fields: Readonly<Record<string, Field>> }
    | { kind: "union"; options: readonly Node[] }
    | { kind: "named"; name: string; description: string; node: Node };

/** `absent`: the key must not appear (a variant that excludes another's field); its node is never read. */
export interface Field {
    node: Node;
    presence: "required" | "optional" | "absent";
    /** What a refusal says the value should be. */
    hint?: string;
}

export interface Schema<T> {
    readonly node: Node;
    /** Carries `T` for `Infer`; never set. */
    readonly type?: T;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

interface FieldSchema<T, P extends Field["presence"]> {
    readonly field: Field & { presence: P };
    readonly type?: T;
}

type Shape = Readonly<Record<string, Schema<unknown> | FieldSchema<unknown, Field["presence"]>>>;
type FieldType<S> = S extends FieldSchema<infer T, infer P> ? (P extends "absent" ? undefined : T) : Infer<S>;
type Keys<S, P> = { [K in keyof S]: S[K] extends FieldSchema<unknown, infer Q> ? (Q extends P ? K : never) : P extends "required" ? K : never }[keyof S];
type Fields<S> = { [K in keyof S]: FieldType<S[K]> };
type Flat<T> = { [K in keyof T]: T[K] } & {};
type ObjectType<S> = Flat<Pick<Fields<S>, Keys<S, "required">> & Partial<Pick<Fields<S>, Keys<S, "optional" | "absent">>>>;

const schema = <T>(node: Node): Schema<T> => ({ node });

/** Any string, empty included. */
export const string = (): Schema<string> => schema({ kind: "string" });
/** A non-empty string. */
export const text = (): Schema<string> => schema({ kind: "string", format: "text" });
/** An amount or quantity as a decimal string: "150.00", "-1", "0.5". Never a number. */
export const decimal = (): Schema<string> => schema({ kind: "string", format: "decimal" });
/** An ISO calendar date: "2026-10-23". */
export const date = (): Schema<string> => schema({ kind: "string", format: "date" });
/** An ISO 4217 currency code this library knows: "MYR". */
export const currency = (): Schema<string> => schema({ kind: "string", format: "currency" });
/** An IANA time zone: "Asia/Kuala_Lumpur". */
export const timeZone = (): Schema<string> => schema({ kind: "string", format: "timeZone" });
export const number = (): Schema<number> => schema({ kind: "number" });
export const integer = (bounds: { min?: number; max?: number } = {}): Schema<number> => schema({ kind: "number", integer: true, ...bounds });
export const boolean = (): Schema<boolean> => schema({ kind: "boolean" });
export const literal = <const V extends string | number | boolean>(value: V): Schema<V> => schema({ kind: "literal", value });
export const oneOf = <const V extends readonly string[]>(values: V): Schema<V[number]> =>
    schema({ kind: "union", options: values.map((value) => ({ kind: "literal", value })) });
export const array = <T>(item: Schema<T>): Schema<readonly T[]> => schema({ kind: "array", item: item.node });
export const record = <T>(value: Schema<T>): Schema<Readonly<Record<string, T>>> => schema({ kind: "record", value: value.node });

export const optional = <T>(s: Schema<T>, hint?: string): FieldSchema<T, "optional"> => ({ field: { node: s.node, presence: "optional", ...(hint !== undefined && { hint }) } });
export const required = <T>(s: Schema<T>, hint: string): FieldSchema<T, "required"> => ({ field: { node: s.node, presence: "required", hint } });
export const absent = (): FieldSchema<undefined, "absent"> => ({ field: { node: { kind: "boolean" }, presence: "absent" } });

export function object<S extends Shape>(shape: S): Schema<ObjectType<S>> {
    const fields: Record<string, Field> = {};
    for (const [key, s] of Object.entries(shape)) fields[key] = "field" in s ? s.field : { node: s.node, presence: "required" };
    return schema({ kind: "object", fields });
}

export const union = <const S extends readonly Schema<unknown>[]>(...options: S): Schema<Infer<S[number]>> =>
    schema({ kind: "union", options: options.map((o) => o.node) });

/** The field names of an object shape, read from its one definition. */
export function fieldNames<T extends object>(s: Schema<T>): (keyof T & string)[] {
    const node = objectOf(s.node);
    if (!node) throw new Error("fieldNames takes an object shape");
    // The names come from the same definition `T` is inferred from.
    return Object.keys(node.fields) as (keyof T & string)[];
}

/** A shape with a name: a `$defs` entry in JSON Schema and a `v<Name>` validator in Convex. */
export const named = <T>(name: string, description: string, s: Schema<T>): Schema<T> => schema({ kind: "named", name, description, node: s.node });

/**
 * Checks untyped input against a schema and returns a typed copy holding only
 * the shape's fields, so what was checked is what the caller stores. A refusal
 * is an `InvoiceError` with a path into the input: `lines[0].quantity`.
 */
export function parse<T>(s: Schema<T>, value: unknown, path = ""): T {
    // `check` has just proved the copy has the shape `T` describes.
    return check(s.node, value, path, undefined) as T;
}

const at = (path: string, key: string) => (path ? `${path}.${key}` : key);
const describe = (value: unknown) => (value === null ? "null" : Array.isArray(value) ? "a list" : typeof value);
const knows = (node: Extract<Node, { kind: "object" }>, key: string) => Object.hasOwn(node.fields, key) && node.fields[key]!.presence !== "absent";

function check(node: Node, value: unknown, path: string, hint: string | undefined): unknown {
    const refuse = (code: "invalid-argument" | "invalid-amount" | "invalid-date" | "missing-field" | "unknown-currency", detail: string): never => {
        throw new InvoiceError(code, path, hint ?? detail);
    };
    switch (node.kind) {
        case "named":
            return check(node.node, value, path, hint);
        case "string":
            if (node.format === "decimal" && typeof value === "number") {
                throw new InvoiceError("invalid-amount", path, `pass ${value} as a string, "${value}": amounts never pass through a float`);
            }
            if (typeof value !== "string") return refuse("invalid-argument", `expected a string, got ${describe(value)}`);
            if (node.format === "text" && value === "") return refuse("missing-field", "must not be empty");
            if (node.format === "decimal" && !DECIMAL.test(value)) return refuse("invalid-amount", `${JSON.stringify(value)} is not a decimal`);
            if (node.format === "date" && !isDate(value)) return refuse("invalid-date", `${value} is not a calendar date`);
            if (node.format === "currency" && !Object.hasOwn(MINOR_UNITS, value)) return refuse("unknown-currency", `unknown ISO 4217 currency ${value}`);
            if (node.format === "timeZone" && !isTimeZone(value)) return refuse("invalid-argument", `${value} is not an IANA time zone`);
            return value;
        case "number":
            if (typeof value !== "number" || !Number.isFinite(value) || (node.integer && !Number.isInteger(value))) {
                return refuse("invalid-argument", `expected ${node.integer ? "a whole number" : "a number"}, got ${describe(value)}`);
            }
            if ((node.min !== undefined && value < node.min) || (node.max !== undefined && value > node.max)) {
                return refuse("invalid-argument", `expected ${node.min ?? "any"} to ${node.max ?? "any"}, got ${value}`);
            }
            return value;
        case "boolean":
            if (typeof value !== "boolean") return refuse("invalid-argument", `expected true or false, got ${describe(value)}`);
            return value;
        case "literal":
            if (value !== node.value) return refuse("invalid-argument", `expected ${JSON.stringify(node.value)}`);
            return value;
        case "array":
            if (!Array.isArray(value)) return refuse("invalid-argument", `expected a list, got ${describe(value)}`);
            return value.map((item, i) => check(node.item, item, `${path}[${i}]`, undefined));
        case "record": {
            if (!isObject(value)) return refuse("invalid-argument", `expected an object, got ${describe(value)}`);
            const out: Record<string, unknown> = {};
            for (const [key, item] of Object.entries(value)) {
                if (!RECORD_KEY.test(key)) throw new InvoiceError("invalid-argument", at(path, key), "a key is printable ASCII and does not start with $ or _");
                out[key] = check(node.value, item, at(path, key), undefined);
            }
            return out;
        }
        case "object": {
            if (!isObject(value)) return refuse("invalid-argument", `expected an object, got ${describe(value)}`);
            // Discriminants first: a wrong `type` says more than the fields that follow from it.
            for (const [key, field] of Object.entries(node.fields)) {
                if (field.node.kind === "literal" && value[key] !== undefined) check(field.node, value[key], at(path, key), field.hint);
            }
            for (const key of Object.keys(value)) {
                if (value[key] !== undefined && !knows(node, key)) {
                    throw new InvoiceError("invalid-argument", at(path, key), `unknown field; expected ${Object.keys(node.fields).join(", ")}`);
                }
            }
            const out: Record<string, unknown> = {};
            for (const [key, field] of Object.entries(node.fields)) {
                const item = value[key];
                if (item === undefined) {
                    if (field.presence === "required") throw new InvoiceError("missing-field", at(path, key), field.hint ?? "required");
                    continue;
                }
                out[key] = check(field.node, item, at(path, key), field.hint);
            }
            return out;
        }
        case "union": {
            if (node.options.every((o) => o.kind === "literal")) {
                if (node.options.some((o) => o.kind === "literal" && o.value === value)) return value;
                return refuse("invalid-argument", `expected one of ${node.options.map((o) => (o.kind === "literal" ? JSON.stringify(o.value) : "")).join(", ")}`);
            }
            // The value is refused as the option it fits best, which is the one the caller meant.
            let refusal: InvoiceError | undefined;
            for (const option of candidates(node.options, value, path)) {
                try {
                    return check(option, value, path, undefined);
                } catch (e) {
                    if (!(e instanceof InvoiceError)) throw e;
                    refusal ??= e;
                }
            }
            if (hint !== undefined && refusal!.path === path) throw new InvoiceError(refusal!.code, path, hint);
            throw refusal!;
        }
    }
}

/** Keys every store accepts as field names: printable ASCII, not starting with $ or _ (Convex reserves those). */
const RECORD_KEY = /^[\x21-\x23\x25-\x5e\x60-\x7e][\x20-\x7e]*$/;

const objectOf = (node: Node): Extract<Node, { kind: "object" }> | undefined =>
    node.kind === "named" ? objectOf(node.node) : node.kind === "object" ? node : undefined;

/**
 * The options of a union the value most plausibly meant: those whose literal
 * fields it matches, then those it fits best (fields it has that the option
 * knows, required ones counting twice, less fields the option does not know).
 * A value whose discriminant matches no option is refused at that field.
 */
function candidates(options: readonly Node[], value: unknown, path: string): readonly Node[] {
    if (!isObject(value) || !options.every((o) => objectOf(o))) return options;
    const objects = options.map((o) => ({ option: o, node: objectOf(o)! }));
    const literals = (n: Extract<Node, { kind: "object" }>) => Object.entries(n.fields).filter(([, f]) => f.node.kind === "literal");
    const matching = objects.filter(({ node }) => literals(node).every(([k, f]) => f.node.kind === "literal" && (value[k] === undefined ? f.presence !== "required" : value[k] === f.node.value)));
    if (matching.length === 0) {
        const keys = objects.map(({ node }) => literals(node).map(([k]) => k));
        const shared = keys[0]?.find((k) => keys.every((ks) => ks.includes(k)) && value[k] !== undefined);
        if (shared !== undefined) {
            const allowed = objects.map(({ node }) => node.fields[shared]!.node).map((n) => (n.kind === "literal" ? JSON.stringify(n.value) : ""));
            throw new InvoiceError("invalid-argument", at(path, shared), `expected one of ${allowed.join(", ")}`);
        }
        return options;
    }
    const fit = ({ node }: { node: Extract<Node, { kind: "object" }> }) =>
        Object.keys(value).reduce((score, k) => {
            if (value[k] === undefined) return score;
            if (!knows(node, k)) return score - 1;
            return score + (node.fields[k]!.presence === "required" ? 2 : 1);
        }, 0);
    const top = Math.max(...matching.map(fit));
    return matching.filter((o) => fit(o) === top).map(({ option }) => option);
}

/** JSON Schema (2020-12) for the given named shapes, each a `$defs` entry. */
export function jsonSchema(id: string, shapes: readonly Schema<unknown>[]): Record<string, unknown> {
    const defs: Record<string, unknown> = {};
    const visit = (node: Node): Record<string, unknown> => {
        switch (node.kind) {
            case "named":
                if (!(node.name in defs)) {
                    defs[node.name] = {};
                    defs[node.name] = { description: node.description, ...visit(node.node) };
                }
                return { $ref: `#/$defs/${node.name}` };
            case "string":
                switch (node.format) {
                    case "decimal":
                        return { type: "string", pattern: DECIMAL.source };
                    case "date":
                        return { type: "string", format: "date" };
                    case "text":
                        return { type: "string", minLength: 1 };
                    case "currency":
                        return { type: "string", pattern: "^[A-Z]{3}$", description: "An ISO 4217 currency code" };
                    case "timeZone":
                        return { type: "string", minLength: 1, description: "An IANA time zone" };
                    default:
                        return { type: "string" };
                }
            case "number":
                return { type: node.integer ? "integer" : "number", ...(node.min !== undefined && { minimum: node.min }), ...(node.max !== undefined && { maximum: node.max }) };
            case "boolean":
                return { type: "boolean" };
            case "literal":
                return { const: node.value };
            case "array":
                return { type: "array", items: visit(node.item) };
            case "record":
                return { type: "object", propertyNames: { pattern: RECORD_KEY.source }, additionalProperties: visit(node.value) };
            case "object": {
                const present = Object.entries(node.fields).filter(([, f]) => f.presence !== "absent");
                return {
                    type: "object",
                    properties: Object.fromEntries(present.map(([k, f]) => [k, visit(f.node)])),
                    required: present.filter(([, f]) => f.presence === "required").map(([k]) => k),
                    additionalProperties: false,
                };
            }
            case "union":
                return { anyOf: node.options.map(visit) };
        }
    };
    for (const s of shapes) visit(s.node);
    return { $schema: "https://json-schema.org/draft/2020-12/schema", $id: id, $defs: defs };
}
