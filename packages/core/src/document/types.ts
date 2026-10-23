/**
 * The document primitive: an invoice or credit note as plain data, the
 * commands that change it, and the events that record each change.
 *
 * Everything here is JSON, defined once in `schema/shapes.ts`. Amounts are
 * decimal strings, dates are ISO calendar dates ("2026-10-23"), instants are
 * ISO timestamps. A backend stores state and events as they are.
 */
import type { Infer } from "../schema/dsl.ts";
import type * as S from "../schema/shapes.ts";

export type DocumentKind = DraftData["kind"];
export type Party = Infer<typeof S.Party>;
export type Address = Infer<typeof S.Address>;
export type Line = Infer<typeof S.Line>;
/** What a draft says. Free to change until the document is issued. */
export type DraftData = Infer<typeof S.DraftData>;
/** The figures fixed at issue: what the document legally says, as strings. */
export type Figures = Infer<typeof S.Figures>;
/** Money that settled part of an issued document: a payment, a credit note, a write-off. */
export type Settlement = Infer<typeof S.Settlement>;
export type Delivery = Infer<typeof S.Delivery>;
export type DeliveryRequest = Infer<typeof S.DeliveryRequest>;
export type DeliveryStatus = Infer<typeof S.DeliveryStatus>;
export type NewSettlement = Infer<typeof S.NewSettlement>;
export type DraftState = Infer<typeof S.DraftState>;
export type DiscardedState = Infer<typeof S.DiscardedState>;
export type IssuedState = Infer<typeof S.IssuedState>;
export type VoidState = Infer<typeof S.VoidState>;
export type DocumentState = Infer<typeof S.DocumentState>;
export type DocumentEvent = Infer<typeof S.DocumentEvent>;

export type Command =
    | { type: "create"; id: string; data: DraftData }
    | { type: "update"; data: DraftData }
    | { type: "discard" }
    /** `number` comes from the backend's sequence, allocated in the same transaction (see `numberFor`). */
    | { type: "issue"; number: string }
    | { type: "void"; reason: string }
    | { type: "settle"; settlement: NewSettlement }
    | { type: "reverse-settlement"; settlementId: string; reason: string }
    | { type: "request-delivery"; delivery: DeliveryRequest }
    | { type: "complete-delivery"; deliveryId: string; status: DeliveryStatus; detail?: string };
