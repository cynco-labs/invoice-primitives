/**
 * The short way in. A tenant is configured once (country, seller, currency);
 * after that a document needs only a buyer and lines, and a line can name its
 * tax ("service-8") instead of spelling out categories and rates.
 *
 *   await books.configure({ country: "MY", seller: { name: "Kedai Kopi Sdn Bhd" } });
 *   await books.create({ buyer: { name: "Acme" }, lines: [{ name: "Consulting", quantity: "10", price: "150.00", tax: "service-8" }] });
 *
 * `expand` turns that into the full `DraftData` the events record, so what a
 * document says never depends on settings changed later.
 */
import type { TaxInput } from "../calc/model.ts";
import { minorUnits } from "../calc/compute.ts";
import { InvoiceError } from "../errors.ts";
import type { Registry } from "../pack.ts";
import { defaultNumbering, type Context, type Numbering } from "./execute.ts";
import type { DocumentKind, DraftData, Line, Party } from "./types.ts";

/** A tenant's settings. Every backend stores them per tenant. */
export interface Settings {
    /** The country pack (ISO 3166-1 alpha-2, or "EU"): its default policy, currency, time zone and named taxes. */
    country?: string;
    /** The seller on every document that does not name one. */
    seller?: Party;
    /** ISO 4217. Defaults to the country's currency. */
    currency?: string;
    /** IANA time zone: an issue date is the seller's calendar date. Defaults to the country's, then UTC. */
    timeZone?: string;
    /** How numbers read. Default INV-{yyyy}-00001 and CN-{yyyy}-00001. */
    numbering?: Numbering;
}

export type NewLine = Omit<Line, "id" | "taxes"> & {
    /** Defaults to the line's position, "1", "2"... */
    id?: string;
    /** A named tax from the country pack ("service-8", "exempt"). */
    tax?: string;
    taxes?: Line["taxes"];
};

/** A document with only what changes per document. Everything else comes from the tenant's settings. */
export type NewDocument = Omit<DraftData, "kind" | "policy" | "currency" | "seller" | "lines"> & {
    /** Choose it to make a retried create harmless. Generated when absent. */
    id?: string;
    kind?: DocumentKind;
    policy?: string;
    currency?: string;
    seller?: Party;
    lines: readonly NewLine[];
};

/** Refuses settings a backend must not store. */
export function checkSettings(settings: Settings, registry: Registry): void {
    if (settings.country !== undefined) registry.country(settings.country);
    if (settings.timeZone !== undefined) {
        try {
            new Intl.DateTimeFormat("en", { timeZone: settings.timeZone });
        } catch {
            throw new InvoiceError("invalid-argument", "timeZone", `${settings.timeZone} is not an IANA time zone`);
        }
    }
    if (settings.currency !== undefined) {
        try {
            minorUnits(settings.currency);
        } catch (e) {
            throw e instanceof InvoiceError ? new InvoiceError("unknown-currency", "currency", e.detail) : e;
        }
    }
    if (settings.seller !== undefined) checkParty(settings.seller, "seller");
    if (settings.numbering !== undefined) {
        for (const kind of Object.keys(defaultNumbering) as (keyof Numbering)[]) {
            const format = settings.numbering[kind];
            if (!format || typeof format.prefix !== "string" || !(Number.isInteger(format.digits) && format.digits >= 1 && format.digits <= 12)) {
                throw new InvoiceError("invalid-argument", `numbering.${kind}`, "a prefix and 1 to 12 digits");
            }
        }
    }
}

/** The context a backend runs a command in: the tenant's settings with the country's defaults filled in. */
export function contextFor(settings: Settings, registry: Registry, now: string): Context {
    const pack = settings.country === undefined ? undefined : registry.country(settings.country);
    const policy = pack ? pack.policies[pack.defaults.policy]?.id : undefined;
    const currency = settings.currency ?? pack?.defaults.currency;
    return {
        now,
        timeZone: settings.timeZone ?? pack?.defaults.timeZone ?? "UTC",
        registry,
        ...(settings.numbering && { numbering: settings.numbering }),
        defaults: {
            ...(policy && { policy }),
            ...(currency && { currency }),
            ...(settings.seller && { seller: settings.seller }),
        },
    };
}

/**
 * What TypeScript would have caught, for callers that send JSON from a form or
 * another language: a refusal with a path and a hint instead of a TypeError.
 */
function checkShape(input: NewDocument): void {
    const text = (value: unknown, path: string, hint: string) => {
        if (typeof value !== "string" || value === "") {
            throw new InvoiceError(typeof value === "number" ? "invalid-amount" : "missing-field", path, typeof value === "number" ? `pass ${value} as a string, "${value}": amounts never pass through a float` : hint);
        }
    };
    if (typeof input !== "object" || input === null) throw new InvoiceError("invalid-argument", "", "a document is an object");
    checkParty(input.buyer, "buyer");
    if (input.seller !== undefined) checkParty(input.seller, "seller");
    if (!Array.isArray(input.lines)) throw new InvoiceError("invalid-argument", "lines", "lines is a list of { name, quantity, price, tax }");
    input.lines.forEach((line, i) => {
        text(line?.name, `lines[${i}].name`, "a line has a name");
        text(line.quantity, `lines[${i}].quantity`, 'a quantity is a decimal string, like "10"');
        text(line.price, `lines[${i}].price`, 'a price is a decimal string, like "150.00"');
        if (line.taxes !== undefined && !Array.isArray(line.taxes)) {
            throw new InvoiceError("invalid-argument", `lines[${i}].taxes`, 'taxes is a list, like [{ category: "S", rate: "8" }]');
        }
    });
}

function checkParty(party: Party | undefined, path: string): void {
    if (typeof party !== "object" || party === null || typeof party.name !== "string" || party.name === "") {
        throw new InvoiceError("missing-field", `${path}.name`, `the ${path} has a name`);
    }
    if (party.address !== undefined && !(Array.isArray(party.address.lines) && party.address.lines.every((l) => typeof l === "string"))) {
        throw new InvoiceError("invalid-argument", `${path}.address.lines`, 'street lines are a list: { lines: ["Lot 12, Jalan Ampang"], country: "MY" }');
    }
}

/** The full draft a short document stands for. */
export function expand(input: NewDocument, ctx: Context): DraftData {
    checkShape(input);
    const { id: _id, kind = "invoice", lines, ...rest } = input;
    const policy = input.policy ?? ctx.defaults?.policy;
    if (!policy) throw new InvoiceError("missing-field", "policy", "configure a country, or name a policy on the document");
    const seller = input.seller ?? ctx.defaults?.seller;
    if (!seller) throw new InvoiceError("missing-field", "seller", "configure a seller, or name one on the document");
    const currency = input.currency ?? ctx.defaults?.currency;
    if (!currency) throw new InvoiceError("missing-field", "currency", "configure a currency, or name one on the document");
    const { pack } = ctx.registry.resolve(policy);

    return {
        ...rest,
        kind,
        policy,
        currency,
        seller,
        lines: lines.map((line, i): Line => {
            const { tax, taxes, id, ...fields } = line;
            if (tax !== undefined && taxes !== undefined) {
                throw new InvoiceError("invalid-argument", `lines[${i}]`, "a line names a tax or lists taxes, not both");
            }
            let resolved: readonly TaxInput[] = taxes ?? [];
            if (tax !== undefined) {
                if (!Object.hasOwn(pack.taxes, tax)) {
                    throw new InvoiceError("invalid-tax", `lines[${i}].tax`, `${pack.id} has no tax named ${tax}; it has ${Object.keys(pack.taxes).join(", ")}`);
                }
                resolved = pack.taxes[tax]!.taxes;
            }
            return { ...fields, id: id ?? String(i + 1), taxes: resolved };
        }),
    };
}
