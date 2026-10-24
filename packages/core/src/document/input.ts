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
import { parse, type Infer } from "../schema/dsl.ts";
import * as S from "../schema/shapes.ts";
import { InvoiceError } from "../errors.ts";
import type { Registry } from "../pack.ts";
import type { Context } from "./execute.ts";
import type { DraftData, Line } from "./types.ts";

/** A tenant's settings. Every backend stores them per tenant. */
export type Settings = Infer<typeof S.Settings>;
export type NewLine = Infer<typeof S.NewLine>;
/** A document with only what changes per document. Everything else comes from the tenant's settings. */
export type NewDocument = Infer<typeof S.NewDocument>;

/** The settings a backend may store, or a refusal: their shape, then that their country has a pack. */
export function checkSettings(settings: Settings, registry: Registry): Settings {
    const checked = parse(S.Settings, settings);
    if (checked.country !== undefined) registry.country(checked.country);
    return checked;
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

/** The full draft a short document stands for. */
export function expand(given: NewDocument, ctx: Context): DraftData {
    const input = parse(S.NewDocument, given);
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
