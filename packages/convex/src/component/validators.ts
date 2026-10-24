/**
 * Convex validators for core's JSON shapes, generated from core's
 * `schema/shapes.ts` into `shapes.generated.ts` (`pnpm gen`), and used for the
 * schema, the arguments and the return values alike.
 *
 * `Infer<typeof vX>` is core's type with `readonly` dropped from its arrays,
 * since Convex values have no readonly arrays. `test/types.ts` fails to
 * typecheck if a validator and its core type differ in anything else.
 */
import type { CountryPack, CreditNoteInput, DocumentState, ListQuery, NewDocument, Settings, StoredEvent } from "@invoice-primitives/core";
import type { Infer } from "convex/values";
import type { vCountryPack, vCreditNoteInput, vDocumentState, vListQuery, vNewDocument, vSettings, vStoredEvent } from "./shapes.generated.ts";

export * from "./shapes.generated.ts";

/**
 * Core values as Convex values. Core's types mark arrays `readonly`; Convex's
 * `Value` type has no readonly arrays. The JSON is identical, so each of these
 * changes the static type and nothing else, and Convex still checks every
 * value against the validators at runtime.
 */
export const asValue = {
    state: (state: DocumentState) => state as Infer<typeof vDocumentState>,
    stateOrNull: (state: DocumentState | undefined) => (state ? asValue.state(state) : null),
    stored: (event: StoredEvent) => event as Infer<typeof vStoredEvent>,
    document: (document: NewDocument) => document as Infer<typeof vNewDocument>,
    settings: (settings: Settings) => settings as Infer<typeof vSettings>,
    creditNote: (input: CreditNoteInput) => input as Infer<typeof vCreditNoteInput>,
    query: (query: ListQuery) => query as Infer<typeof vListQuery>,
    packs: (packs: readonly CountryPack[]) => packs as Infer<typeof vCountryPack>[],
};
