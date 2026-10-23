/**
 * Convex validators for core's JSON shapes (`document/types.ts`, `calc/model.ts`),
 * used for the schema, the arguments and the return values alike.
 *
 * `Infer<typeof vX>` is core's type with `readonly` dropped from its arrays,
 * since Convex values have no readonly arrays. `test/types.ts` fails to
 * typecheck if a validator and its core type differ in anything else.
 */
import type { CreditNoteInput, DocumentEvent, DocumentState, DraftData, NewDocument, Settings } from "@invoice-primitives/core";
import { v, type Infer } from "convex/values";

const optionalString = v.optional(v.string());

export const vTax = v.object({
    scheme: optionalString,
    category: v.string(),
    rate: optionalString,
    perUnit: optionalString,
    compound: v.optional(v.boolean()),
    exemptionReason: optionalString,
    exemptionReasonCode: optionalString,
});

const reasons = { reason: optionalString, reasonCode: optionalString };
const stated = { ...reasons, amount: v.string(), percent: optionalString, base: optionalString };
const derived = { ...reasons, percent: v.string(), base: v.string() };

export const vAdjustment = v.union(v.object(stated), v.object(derived));

export const vDocumentAdjustment = v.union(
    v.object({ ...stated, taxes: v.array(vTax) }),
    v.object({ ...derived, taxes: v.array(vTax) }),
);

export const vLine = v.object({
    id: v.string(),
    quantity: v.string(),
    price: v.string(),
    baseQuantity: optionalString,
    allowances: v.optional(v.array(vAdjustment)),
    charges: v.optional(v.array(vAdjustment)),
    taxes: v.array(vTax),
    name: v.string(),
    description: optionalString,
    unit: optionalString,
});

/** A line of a short document (core's `NewLine`): its id and taxes may be left out, its tax named. */
export const vNewLine = v.object({
    id: optionalString,
    quantity: v.string(),
    price: v.string(),
    baseQuantity: optionalString,
    allowances: v.optional(v.array(vAdjustment)),
    charges: v.optional(v.array(vAdjustment)),
    taxes: v.optional(v.array(vTax)),
    tax: optionalString,
    name: v.string(),
    description: optionalString,
    unit: optionalString,
});

export const vAddress = v.object({
    lines: v.array(v.string()),
    city: optionalString,
    postalCode: optionalString,
    region: optionalString,
    country: v.string(),
});

export const vParty = v.object({
    name: v.string(),
    ids: v.optional(v.array(v.object({ scheme: v.string(), value: v.string() }))),
    email: optionalString,
    address: v.optional(vAddress),
});

/** The fields a credit note states itself (`CreditNoteInput`); a draft adds the rest. */
const noteFields = {
    lines: v.array(vLine),
    allowances: v.optional(v.array(vDocumentAdjustment)),
    charges: v.optional(v.array(vDocumentAdjustment)),
    issueDate: optionalString,
    due: v.optional(v.union(v.object({ date: v.string() }), v.object({ days: v.number() }))),
    buyerReference: optionalString,
    orderReference: optionalString,
    note: optionalString,
};

export const vCreditNoteInput = v.object(noteFields);

export const vDraftData = v.object({
    ...noteFields,
    kind: v.union(v.literal("invoice"), v.literal("credit-note")),
    policy: v.string(),
    currency: v.string(),
    seller: vParty,
    buyer: vParty,
    corrects: optionalString,
    correctsNumber: optionalString,
});

/** Core's `NewDocument`: a buyer and lines; the tenant's settings supply the rest. */
export const vNewDocument = v.object({
    ...noteFields,
    lines: v.array(vNewLine),
    id: optionalString,
    kind: v.optional(v.union(v.literal("invoice"), v.literal("credit-note"))),
    policy: optionalString,
    currency: optionalString,
    seller: v.optional(vParty),
    buyer: vParty,
    corrects: optionalString,
    correctsNumber: optionalString,
});

export const vFigures = v.object({
    policy: v.string(),
    core: v.string(),
    scale: v.number(),
    lines: v.array(v.object({ id: v.string(), net: v.string() })),
    taxes: v.array(
        v.object({
            scheme: v.string(),
            category: v.string(),
            rate: optionalString,
            perUnit: optionalString,
            taxable: v.string(),
            tax: v.string(),
            exemptionReason: optionalString,
            exemptionReasonCode: optionalString,
        }),
    ),
    totals: v.object({
        lineNet: v.string(),
        allowances: v.string(),
        charges: v.string(),
        taxExclusive: v.string(),
        tax: v.string(),
        taxInclusive: v.string(),
        prepaid: v.string(),
        rounding: v.string(),
        payable: v.string(),
    }),
});

const settlementFields = {
    id: v.string(),
    kind: v.union(v.literal("payment"), v.literal("credit"), v.literal("write-off")),
    amount: v.string(),
    date: v.string(),
    reference: optionalString,
};

/** A settle command's settlement: `Omit<Settlement, "reversed">`. */
export const vNewSettlement = v.object(settlementFields);

const vReversal = v.object({ reason: v.string(), at: v.string() });

export const vSettlement = v.object({ ...settlementFields, reversed: v.optional(vReversal) });

export const vDeliveryStatus = v.union(v.literal("delivered"), v.literal("failed"));

export const vDeliveryRequest = v.object({ id: v.string(), channel: v.string(), to: v.string() });

export const vDelivery = v.object({
    id: v.string(),
    channel: v.string(),
    to: v.string(),
    requestedAt: v.string(),
    outcome: v.optional(v.object({ status: vDeliveryStatus, at: v.string(), detail: optionalString })),
});

const base = { id: v.string(), version: v.number(), data: vDraftData };
const issuedFields = {
    number: v.string(),
    issueDate: v.string(),
    dueDate: v.string(),
    figures: vFigures,
    settlements: v.array(vSettlement),
    deliveries: v.array(vDelivery),
};

export const vDocumentState = v.union(
    v.object({ ...base, status: v.literal("draft") }),
    v.object({ ...base, status: v.literal("discarded") }),
    v.object({ ...base, ...issuedFields, status: v.literal("issued") }),
    v.object({ ...base, ...issuedFields, status: v.literal("void"), voided: vReversal }),
);

export const vDocumentEvent = v.union(
    v.object({ type: v.literal("created"), id: v.string(), data: vDraftData }),
    v.object({ type: v.literal("updated"), data: vDraftData }),
    v.object({ type: v.literal("discarded") }),
    v.object({ type: v.literal("issued"), number: v.string(), issueDate: v.string(), dueDate: v.string(), figures: vFigures }),
    v.object({ type: v.literal("voided"), reason: v.string(), at: v.string() }),
    v.object({ type: v.literal("settled"), settlement: vSettlement }),
    v.object({ type: v.literal("settlement-reversed"), settlementId: v.string(), reason: v.string(), at: v.string() }),
    v.object({ type: v.literal("delivery-requested"), delivery: vDelivery }),
    v.object({
        type: v.literal("delivery-completed"),
        deliveryId: v.string(),
        status: vDeliveryStatus,
        at: v.string(),
        detail: optionalString,
    }),
);

export const vStoredEvent = v.object({
    position: v.number(),
    documentId: v.string(),
    version: v.number(),
    at: v.string(),
    event: vDocumentEvent,
});


const vNumberFormat = v.object({ prefix: v.string(), digits: v.number() });
export const vNumbering = v.object({ invoice: vNumberFormat, "credit-note": vNumberFormat });
export const vSettings = v.object({
    country: optionalString,
    seller: v.optional(vParty),
    currency: optionalString,
    timeZone: optionalString,
    numbering: v.optional(vNumbering),
});

/**
 * Core values as Convex values. Core's types mark arrays `readonly`; Convex's
 * `Value` type has no readonly arrays. The JSON is identical, so each of these
 * changes the static type and nothing else: `test/types.ts` proves the shapes
 * differ only in `readonly`, and Convex still checks every value against the
 * validators above at runtime (arguments, schema, return values).
 */
export const asValue = {
    state: (state: DocumentState) => state as Infer<typeof vDocumentState>,
    event: (event: DocumentEvent) => event as Infer<typeof vDocumentEvent>,
    draft: (data: DraftData) => data as Infer<typeof vDraftData>,
    document: (document: NewDocument) => document as Infer<typeof vNewDocument>,
    settings: (settings: Settings) => settings as Infer<typeof vSettings>,
    creditNote: (input: CreditNoteInput) => input as Infer<typeof vCreditNoteInput>,
};
