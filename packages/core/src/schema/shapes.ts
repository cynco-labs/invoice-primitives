/**
 * Every JSON shape that crosses a boundary: what callers send, what backends
 * store, what packs say. The TypeScript types in `calc/model.ts`,
 * `document/types.ts` and `pack.ts` are inferred from these; the Convex
 * validators and `schema/invoice-primitives.schema.json` are generated from
 * them (`pnpm gen`).
 *
 * Field names follow the EN 16931 semantic model, each with its business term
 * (BT) or group (BG). Amounts are decimal strings ("1300.00"), never numbers.
 */
import { ROUNDING_MODES } from "../money/decimal.ts";
import { absent, array, boolean, currency, date, decimal, integer, literal, named, object, oneOf, optional, record, required, string, text, timeZone, union } from "./dsl.ts";

export const TaxInput = named(
    "TaxInput",
    "One tax a line or adjustment bears (BG-30, BT-151, BT-152).",
    object({
        /** BT-151's scheme. "VAT" is EN 16931's word for any consumption tax (SST, GST). */
        scheme: optional(text()),
        /** BT-151 / BT-118. UNCL5305 (S, Z, E, AE, K, G, O, L, M) or a national code (PINT MY's SA, SE, TTX). */
        category: text(),
        /** BT-152, percent. Absent for a category that levies nothing. */
        rate: optional(decimal()),
        /** A fixed amount per unit of quantity, instead of a rate. */
        perUnit: optional(decimal()),
        /** Levied on the line net plus the line's earlier taxes. */
        compound: optional(boolean()),
        /** BT-120. */
        exemptionReason: optional(string()),
        /** BT-121. */
        exemptionReasonCode: optional(string()),
    }),
);

const reasons = {
    reason: optional(string()),
    reasonCode: optional(string()),
};
const statedAmount = {
    ...reasons,
    /** BT-136 / BT-141 / BT-92 / BT-99. */
    amount: decimal(),
    percent: optional(decimal()),
    base: optional(decimal()),
};
const percentOfBase = {
    ...reasons,
    amount: absent(),
    /** BT-138 / BT-143 / BT-94 / BT-101. */
    percent: decimal(),
    /** BT-137 / BT-142 / BT-93 / BT-100. */
    base: decimal(),
};

export const Adjustment = named(
    "Adjustment",
    "An allowance or charge: a stated amount, or a percent of a stated base. A stated amount wins; its percent and base are then recorded, not checked. Under tax-inclusive prices a line adjustment is tax-inclusive too.",
    union(object(statedAmount), object(percentOfBase)),
);

export const DocumentAdjustment = named(
    "DocumentAdjustment",
    "A document-level allowance (BG-20) or charge (BG-21). EN 16931 requires its tax category (BT-95 / BT-102).",
    union(object({ ...statedAmount, taxes: array(TaxInput) }), object({ ...percentOfBase, taxes: array(TaxInput) })),
);

const lineInput = {
    /** BT-126. */
    id: text(),
    /** BT-129, as a decimal string ("10", "1.5"). Negative for an item returned within an invoice; a credit note's lines are positive. */
    quantity: required(decimal(), 'a quantity is a decimal string, like "10"'),
    /** BT-146, the item net price per `baseQuantity`. Tax-inclusive when the policy says prices include tax. */
    price: required(decimal(), 'a price is a decimal string, like "150.00"'),
    /** BT-149. Defaults to 1. */
    baseQuantity: optional(decimal()),
    /** BG-27. */
    allowances: optional(array(Adjustment)),
    /** BG-28. */
    charges: optional(array(Adjustment)),
    /**
     * BG-30. The taxes the line bears, in application order. EN 16931 allows
     * exactly one; the core allows several so compound and per-unit taxes
     * (Malaysian tourism tax, excise) fit the same shape.
     */
    taxes: required(array(TaxInput), 'taxes is a list, like [{ category: "S", rate: "8" }]'),
};

export const LineInput = named("LineInput", "A line to calculate (BG-25).", object(lineInput));

export const InvoiceInput = named(
    "InvoiceInput",
    "What `compute` calculates.",
    object({
        /** BT-5. ISO 4217; its minor unit sets the scale of every amount. */
        currency: text(),
        /** BG-25. */
        lines: array(LineInput),
        /** BG-20. */
        allowances: optional(array(DocumentAdjustment)),
        /** BG-21. */
        charges: optional(array(DocumentAdjustment)),
        /** BT-113. */
        prepaid: optional(decimal()),
        /** BT-114, when the seller states it. Otherwise the policy's cash increment derives it. */
        roundingAmount: optional(decimal()),
    }),
);

const lineText = {
    /** BT-153. */
    name: required(text(), "a line has a name"),
    /** BT-154. */
    description: optional(string()),
    /** BT-130, a UN/ECE Recommendation 20 code ("C62" one, "HUR" hour). */
    unit: optional(string()),
};

export const Line = named("Line", "A document line: a calculated line with its name.", object({ ...lineInput, ...lineText }));

export const NewLine = named(
    "NewLine",
    "A line of a short document: its id defaults to its position, and it can name a tax instead of listing taxes.",
    object({
        ...lineInput,
        ...lineText,
        /** Defaults to the line's position, "1", "2"... */
        id: optional(text()),
        /** A named tax from the country pack ("service-8", "exempt"). */
        tax: optional(text()),
        taxes: optional(array(TaxInput), 'taxes is a list, like [{ category: "S", rate: "8" }]'),
    }),
);

export const Address = named(
    "Address",
    "A postal address (BG-5, BG-8).",
    object({
        /** Street lines, in order: ["Lot 12, Jalan Ampang", "Level 3"]. */
        lines: required(array(string()), 'street lines are a list: { lines: ["Lot 12, Jalan Ampang"], country: "MY" }'),
        city: optional(string()),
        postalCode: optional(string()),
        region: optional(string()),
        /** ISO 3166-1 alpha-2. */
        country: text(),
    }),
);

export const Party = named(
    "Party",
    "A seller or buyer.",
    object({
        /** BT-27 / BT-44. */
        name: required(text(), "a party has a name"),
        /** Tax and registration identifiers: VAT, TIN, BRN, SST... (BT-29..32, BT-46..48). */
        ids: optional(array(object({ scheme: text(), value: text() }))),
        email: optional(string()),
        address: optional(Address),
    }),
);

/** The largest page `list` returns. */
export const MAX_LIST = 200;

export const DocumentKind = named("DocumentKind", "An invoice, or a credit note correcting one.", oneOf(["invoice", "credit-note"]));

/** What a credit note states of its own; a draft adds the rest. */
const noteFields = {
    allowances: optional(array(DocumentAdjustment)),
    charges: optional(array(DocumentAdjustment)),
    /** BT-2. Defaults to the day of issue in the seller's time zone. */
    issueDate: optional(date()),
    /** BT-9 as a date, or payment terms in days after issue. Defaults to the issue date. */
    due: optional(union(object({ date: date() }), object({ days: integer() }))),
    /** BT-10. */
    buyerReference: optional(string()),
    /** BT-13. */
    orderReference: optional(string()),
    /** BT-22. */
    note: optional(string()),
};

const draftFields = {
    ...noteFields,
    seller: Party,
    buyer: required(Party, "a document has a buyer: { name }"),
    /** Your id for the buyer, so `list` can find their documents. Not printed. */
    customer: optional(text()),
    /** For a credit note, the id of the invoice it corrects. */
    corrects: optional(text()),
    /** BT-25: that invoice's number, as printed on the note. */
    correctsNumber: optional(text()),
};

export const DraftData = named(
    "DraftData",
    "What a draft says. Free to change until the document is issued.",
    object({
        ...draftFields,
        kind: DocumentKind,
        /** A policy id from a registered country pack: how the document is calculated. */
        policy: text(),
        /** BT-5. */
        currency: text(),
        lines: array(Line),
    }),
);

export const NewDocument = named(
    "NewDocument",
    "A document with only what changes per document. Everything else comes from the tenant's settings.",
    object({
        ...draftFields,
        /** Choose it to make a retried create harmless. Generated when absent. */
        id: optional(text()),
        kind: optional(DocumentKind),
        policy: optional(text()),
        currency: optional(text()),
        seller: optional(Party),
        lines: required(array(NewLine), "lines is a list of { name, quantity, price, tax }"),
    }),
);

export const CreditNoteInput = named(
    "CreditNoteInput",
    "What a credit note says of its own, in the same short form as `create`. The parties, currency and policy are the invoice's; lines carry positive quantities.",
    object({ ...noteFields, lines: required(array(NewLine), "lines is a list of { name, quantity, price, tax }") }),
);

const NumberFormat = object({ prefix: string(), digits: integer({ min: 1, max: 12 }) });

export const Numbering = named(
    "Numbering",
    'How document numbers read, per kind. "{yyyy}" in a prefix is the issue year; each distinct prefix is its own sequence.',
    object({ invoice: NumberFormat, "credit-note": NumberFormat }),
);

export const Settings = named(
    "Settings",
    "A tenant's settings. Every backend stores them per tenant.",
    object({
        /** The country pack (ISO 3166-1 alpha-2, or "EU"): its default policy, currency, time zone and named taxes. */
        country: optional(text()),
        /** The seller on every document that does not name one. */
        seller: optional(Party),
        /** ISO 4217. Defaults to the country's currency. */
        currency: optional(currency()),
        /** IANA time zone: an issue date is the seller's calendar date. Defaults to the country's, then UTC. */
        timeZone: optional(timeZone()),
        /** How numbers read. Default INV-{yyyy}-00001 and CN-{yyyy}-00001. */
        numbering: optional(Numbering),
    }),
);

const Reversal = object({ reason: string(), at: string() });

const settlementFields = {
    /** Caller-chosen and unique per document. Repeating a settle with the same id and values is a no-op. */
    id: text(),
    kind: oneOf(["payment", "credit", "write-off"]),
    /** Positive, in the document's currency. */
    amount: decimal(),
    /** The calendar date the money moved. */
    date: date(),
    /** A bank reference, payment method, or the id of the other document. */
    reference: optional(string()),
};

export const NewSettlement = named("NewSettlement", "Money that settled part of an issued document, as a settle command states it.", object(settlementFields));

export const Settlement = named(
    "Settlement",
    "Money that settled part of an issued document: a payment, a credit note, a write-off.",
    object({ ...settlementFields, reversed: optional(Reversal) }),
);

export const DeliveryStatus = named("DeliveryStatus", "How a delivery ended.", oneOf(["delivered", "failed"]));

const deliveryRequest = {
    id: text(),
    /** "email", "link", "peppol"... */
    channel: text(),
    to: required(text(), "a delivery needs a recipient"),
};

export const DeliveryRequest = named("DeliveryRequest", "A request to deliver an issued document.", object(deliveryRequest));

export const Delivery = named(
    "Delivery",
    "A delivery of an issued document and its outcome.",
    object({
        ...deliveryRequest,
        requestedAt: string(),
        outcome: optional(object({ status: DeliveryStatus, at: string(), detail: optional(string()) })),
    }),
);

export const Figures = named(
    "Figures",
    "The figures fixed at issue: what the document legally says, as strings.",
    object({
        policy: string(),
        core: string(),
        scale: integer(),
        lines: array(object({ id: string(), net: string() })),
        taxes: array(
            object({
                scheme: string(),
                category: string(),
                rate: optional(string()),
                perUnit: optional(string()),
                taxable: string(),
                tax: string(),
                exemptionReason: optional(string()),
                exemptionReasonCode: optional(string()),
            }),
        ),
        totals: object({
            lineNet: string(),
            allowances: string(),
            charges: string(),
            taxExclusive: string(),
            tax: string(),
            taxInclusive: string(),
            prepaid: string(),
            rounding: string(),
            payable: string(),
        }),
    }),
);

const base = {
    id: string(),
    /** The number of events applied. A backend saves only when this is still what it loaded. */
    version: integer(),
    data: DraftData,
};
const issuedFields = {
    /** BT-1. */
    number: string(),
    issueDate: string(),
    dueDate: string(),
    figures: Figures,
    settlements: array(Settlement),
    deliveries: array(Delivery),
};

export const DraftState = object({ ...base, status: literal("draft") });
export const DiscardedState = object({ ...base, status: literal("discarded") });
export const IssuedState = object({ ...base, ...issuedFields, status: literal("issued") });
export const VoidState = object({ ...base, ...issuedFields, status: literal("void"), voided: Reversal });

export const DocumentState = named("DocumentState", "A document as it stands: draft, discarded, issued or void.", union(DraftState, DiscardedState, IssuedState, VoidState));

export const DocumentEvent = named(
    "DocumentEvent",
    "One change to a document, as the log records it.",
    union(
        object({ type: literal("created"), id: string(), data: DraftData }),
        object({ type: literal("updated"), data: DraftData }),
        object({ type: literal("discarded") }),
        object({ type: literal("issued"), number: string(), issueDate: string(), dueDate: string(), figures: Figures }),
        object({ type: literal("voided"), reason: string(), at: string() }),
        object({ type: literal("settled"), settlement: Settlement }),
        object({ type: literal("settlement-reversed"), settlementId: string(), reason: string(), at: string() }),
        object({ type: literal("delivery-requested"), delivery: Delivery }),
        object({ type: literal("delivery-completed"), deliveryId: string(), status: DeliveryStatus, at: string(), detail: optional(string()) }),
    ),
);

export const StoredEvent = named(
    "StoredEvent",
    "An event in a tenant's log.",
    object({
        /** Position in the tenant's log, from 1, with no gaps. */
        position: integer(),
        /** The shape of `event`: EVENT_FORMAT when it was written. A reader refuses a format newer than its own. */
        format: integer(),
        documentId: string(),
        /** The document's version after this event. */
        version: integer(),
        at: string(),
        event: DocumentEvent,
    }),
);

export const STAGES = ["draft", "open", "settled", "void", "discarded"] as const;

export const Stage = named("Stage", "Where a document stands, as a list shows it.", oneOf(STAGES));

export const Listing = named(
    "Listing",
    "The fields a store indexes for `list`, derived from a document's state on every save.",
    object({
        kind: DocumentKind,
        stage: Stage,
        customer: optional(text()),
        /** Issued and void documents only. */
        dueDate: optional(string()),
    }),
);

export const ListQuery = named(
    "ListQuery",
    "Which documents to list, newest first.",
    object({
        kind: optional(DocumentKind),
        /** "open" includes partly settled and overdue documents. Without a status, every stage but "discarded". */
        status: optional(oneOf([...STAGES, "overdue"])),
        /** With status "overdue", the date it is judged on. Defaults to today in the seller's time zone. */
        asOf: optional(date()),
        /** The `customer` the documents were created with. */
        customer: optional(text()),
        /** The previous page's `next`. */
        cursor: optional(string()),
        /** 1 to MAX_LIST documents, default 50. */
        limit: optional(integer({ min: 1, max: MAX_LIST })),
    }),
);

export const ListPage = named(
    "ListPage",
    "A page of documents.",
    object({
        /** Newest first, in the order they were created. */
        documents: array(DocumentState),
        /** The cursor for the next page, absent at the end. A page may be short, or empty, and still have a next. */
        next: optional(string()),
    }),
);

const Rounding = object({
    /** Line gross, percentage adjustments, cash rounding. */
    amounts: oneOf(ROUNDING_MODES),
    /** Tax amounts and tax extracted from inclusive prices. */
    tax: oneOf(ROUNDING_MODES),
});

const policyBase = {
    id: text(),
    rounding: Rounding,
    /** Round the amount due to this increment, recording BT-114 (Malaysia: "0.05"). */
    cashIncrement: optional(decimal()),
};

export const DocumentRounding = object({
    ...policyBase,
    /** Tax per (scheme, category, rate) on the summed taxable amount, rounded once: EN 16931 BR-CO-17, PINT, Japan. */
    taxRounding: literal("document"),
    /**
     * false: prices are net of tax (EN 16931).
     * "extract": tax = round(gross × rate ÷ (100 + rate)), taxable = gross − tax
     * (Japan; most retail). BR-CO-17 can be a unit off.
     * "reconcile": the taxable amount is chosen so BR-CO-17 holds; a gross no
     * taxable amount reaches leaves its residual in BT-114.
     */
    pricesIncludeTax: union(literal(false), literal("extract"), literal("reconcile")),
});

export const LineRounding = object({
    ...policyBase,
    /** Tax per line per tax, rounded each time, then summed. */
    taxRounding: literal("line"),
    pricesIncludeTax: union(literal(false), literal("extract")),
});

export const Policy = named(
    "Policy",
    "How a jurisdiction rounds. Change behaviour by publishing a new policy id, never by editing one.",
    union(DocumentRounding, LineRounding),
);

export const TaxCategory = named(
    "TaxCategory",
    "A tax category a pack recognises.",
    object({
        label: text(),
        /** Whether the category levies tax at a rate (S) or not at all (E, Z, O). */
        levies: boolean(),
    }),
);

export const NamedTax = named(
    "NamedTax",
    'A tax a line can name instead of spelling out: tax: "service-8".',
    object({
        label: text(),
        taxes: array(TaxInput),
        /** Where the rate is written down. */
        source: text(),
        /** The day someone last checked the source. Rates change. */
        checked: date(),
    }),
);

export const RuleCheck = named(
    "RuleCheck",
    'What a rule requires of an issued document, at a path into { data, figures }: "data.buyer.ids[scheme=TIN].value". "[]" visits every element.',
    union(
        /** At least one non-empty value at the path. */
        object({ require: text() }),
        /** Every value at the path matches the regular expression. */
        object({ match: text(), pattern: text() }),
        /** Every value at the path is one of `values`. */
        object({ oneOf: text(), values: array(string()) }),
    ),
);

export const Rule = named(
    "Rule",
    "A rule every document issued under a pack meets.",
    object({
        id: text(),
        message: text(),
        /** Where the rule is written down. */
        source: text(),
        check: RuleCheck,
    }),
);

export const Voiding = named(
    "Voiding",
    "Whether an issued document may be voided. Otherwise it is corrected with a credit note.",
    union(
        object({ allowed: literal(true) }),
        object({ allowed: literal(false), reason: text() }),
        /** Allowed until `hours` after a clearance authority validated the document; always, before it has. */
        object({ allowed: literal("within"), hours: integer({ min: 0 }), after: literal("validation"), reason: text() }),
    ),
);

export const CountryPack = named(
    "CountryPack",
    "What the core knows about a jurisdiction, as data: its policies, tax categories, named taxes, rules and voiding.",
    object({
        /** ISO 3166-1 alpha-2, or a supranational code (EU). */
        id: text(),
        policies: record(Policy),
        /** Every tax category a line may carry under this pack's policies. */
        taxCategories: record(TaxCategory),
        rules: array(Rule),
        /** What a tenant in this country gets without configuring it. `policy` is a key of `policies`. */
        defaults: object({ policy: text(), currency: optional(currency()), timeZone: optional(timeZone()) }),
        /** Taxes a line can name with `tax`. */
        taxes: record(NamedTax),
        voiding: Voiding,
    }),
);

/** Every named shape, for the generators. */
export const shapes = [
    DocumentKind,
    Stage,
    Listing,
    TaxInput,
    Adjustment,
    DocumentAdjustment,
    LineInput,
    InvoiceInput,
    Line,
    NewLine,
    Address,
    Party,
    DraftData,
    NewDocument,
    CreditNoteInput,
    Numbering,
    Settings,
    NewSettlement,
    Settlement,
    DeliveryStatus,
    DeliveryRequest,
    Delivery,
    Figures,
    DocumentState,
    DocumentEvent,
    StoredEvent,
    ListQuery,
    ListPage,
    Policy,
    TaxCategory,
    NamedTax,
    RuleCheck,
    Rule,
    Voiding,
    CountryPack,
] as const;
