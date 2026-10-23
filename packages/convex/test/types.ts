/**
 * Compile-time only (`pnpm typecheck`): each validator accepts exactly its
 * core type, up to `readonly` on arrays (Convex values have none). If core
 * changes a shape, this file stops typechecking until the validator follows.
 */
import type { CreditNoteInput, DocumentEvent, DocumentState, DraftData, NewDocument, Settings, Settlement, StoredEvent } from "@invoice-primitives/core";
import type { Infer } from "convex/values";
import type {
    vCreditNoteInput,
    vDocumentEvent,
    vDocumentState,
    vDraftData,
    vNewDocument,
    vNewSettlement,
    vSettings,
    vStoredEvent,
} from "../src/component/validators.ts";

/** `T` with `readonly` dropped from every array in it. */
type Thaw<T> = T extends readonly (infer E)[] ? Thaw<E>[] : T extends object ? { [K in keyof T]: Thaw<T[K]> } : T;

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export const validatorsMatchCore: [
    Same<Infer<typeof vDraftData>, Thaw<DraftData>>,
    Same<Infer<typeof vCreditNoteInput>, Thaw<CreditNoteInput>>,
    Same<Infer<typeof vNewSettlement>, Thaw<Omit<Settlement, "reversed">>>,
    Same<Infer<typeof vDocumentState>, Thaw<DocumentState>>,
    Same<Infer<typeof vDocumentEvent>, Thaw<DocumentEvent>>,
    Same<Infer<typeof vStoredEvent>, Thaw<StoredEvent>>,
    Same<Infer<typeof vNewDocument>, Thaw<NewDocument>>,
    Same<Infer<typeof vSettings>, Thaw<Settings>>,
] = [true, true, true, true, true, true, true, true];
