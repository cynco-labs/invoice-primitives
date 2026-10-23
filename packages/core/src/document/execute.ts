/**
 * The document state machine as two pure functions:
 *
 *   decide(state, command, context) → events     (or an InvoiceError refusing it)
 *   evolve(state, event)            → state
 *
 * `execute` runs both. A backend loads the state, calls `execute` inside its
 * own transaction, and saves the new state and the events if the version it
 * loaded is still current. Nothing here does I/O, so the same rules run in a
 * Convex mutation, a Durable Object, a Postgres transaction or a test.
 *
 *   draft ──issue──▶ issued ──void──▶ void
 *     │                │
 *  discard          settle, reverse-settlement, request/complete-delivery
 *     ▼
 *  discarded
 *
 * A command that repeats what already happened (the same create, issue,
 * settlement id with the same values, delivery id) returns no events, so a
 * retried request is harmless. `create` is a repeat only while the draft is
 * still what it created.
 */
import { compute, minorUnits } from "../calc/compute.ts";
import { verify } from "../calc/verify.ts";
import { InvoiceError } from "../errors.ts";
import { dec } from "../money/decimal.ts";
import type { Registry } from "../pack.ts";
import { balance } from "./balance.ts";
import { addDays, daysBetween, isDate, localDate } from "./dates.ts";
import { toFigures } from "./figures.ts";
import type {
    Command,
    DocumentEvent,
    DocumentKind,
    DocumentState,
    DraftData,
    IssuedState,
    Party,
    Settlement,
    VoidState,
} from "./types.ts";

export interface Context {
    /** ISO timestamp of the command. */
    now: string;
    /** The seller's IANA time zone: the issue date is the seller's calendar date. */
    timeZone: string;
    registry: Registry;
    numbering?: Numbering;
    /** What a short document (`NewDocument`) leaves out. Built by `contextFor` from the tenant's settings. */
    defaults?: { policy?: string; currency?: string; seller?: Party };
}

/**
 * How document numbers read, per kind, as data so any backend can store it.
 * `{yyyy}` in a prefix is the issue year; each distinct prefix is its own
 * sequence, so "INV-{yyyy}-" restarts every year.
 */
export type Numbering = Readonly<Record<DocumentKind, { prefix: string; digits: number }>>;

export const defaultNumbering: Numbering = {
    invoice: { prefix: "INV-{yyyy}-", digits: 5 },
    "credit-note": { prefix: "CN-{yyyy}-", digits: 5 },
};

export function issueDateOf(data: DraftData, ctx: Context): string {
    return data.issueDate ?? localDate(ctx.now, ctx.timeZone);
}

/**
 * Where the number for issuing `data` comes from. A backend takes the next
 * value of `series` in the same transaction that saves the issue, so a refused
 * issue never consumes a number and numbers have no gaps.
 */
export function numberingFor(data: DraftData, ctx: Context): { series: string; format(sequence: number): string } {
    const { prefix, digits } = (ctx.numbering ?? defaultNumbering)[data.kind];
    if (!(Number.isInteger(digits) && digits >= 1 && digits <= 12)) {
        throw new InvoiceError("invalid-argument", `numbering.${data.kind}.digits`, "a number has 1 to 12 digits");
    }
    const series = prefix.replaceAll("{yyyy}", issueDateOf(data, ctx).slice(0, 4));
    return { series, format: (n) => `${series}${String(n).padStart(digits, "0")}` };
}

/** Ten years: longer terms are a data-entry mistake, not a contract. */
const MAX_TERMS = 3650;

export function execute(
    state: DocumentState | undefined,
    command: Command,
    ctx: Context,
): { state: DocumentState | undefined; events: DocumentEvent[] } {
    const events = decide(state, command, ctx);
    return { state: events.reduce<DocumentState | undefined>(evolve, state), events };
}

export function decide(state: DocumentState | undefined, command: Command, ctx: Context): DocumentEvent[] {
    if (Number.isNaN(Date.parse(ctx.now))) throw new Error(`context.now ${ctx.now} is not an ISO timestamp`);
    if (command.type === "create") {
        if (state) {
            if (state.id === command.id && canonical(state.data) === canonical(command.data)) return [];
            throw new InvoiceError("already-exists", "id", `document ${command.id} exists`);
        }
        if (command.data.kind === "credit-note") {
            throw new InvoiceError("invalid-transition", "data.kind", "a credit note is created by crediting its invoice (creditInvoice)");
        }
        validateDraft(command.data, ctx);
        return [{ type: "created", id: command.id, data: command.data }];
    }
    if (!state) throw new InvoiceError("not-found", "id", "no such document");

    switch (command.type) {
        case "update":
            expect(state, ["draft"], command);
            if (command.data.kind !== state.data.kind) throw new InvoiceError("invalid-transition", "data.kind", "a draft keeps its kind");
            validateDraft(command.data, ctx);
            return [{ type: "updated", data: command.data }];

        case "discard":
            if (state.status === "discarded") return [];
            expect(state, ["draft"], command);
            return [{ type: "discarded" }];

        case "issue":
            if (state.status === "issued") return [];
            expect(state, ["draft"], command);
            return [issue(state.data, command.number, ctx)];

        case "void": {
            if (state.status === "void") return [];
            const doc = expect(state, ["issued"], command);
            if (doc.settlements.some((s) => !s.reversed)) {
                throw new InvoiceError("has-settlements", "", "reverse its settlements before voiding; or issue a credit note");
            }
            const decision = ctx.registry.resolve(doc.data.policy).pack.canVoid(doc, ctx.now, {});
            if (!decision.allowed) throw new InvoiceError("void-not-allowed", "", decision.reason);
            return [{ type: "voided", reason: command.reason, at: ctx.now }];
        }

        case "settle": {
            const doc = expect(state, ["issued"], command);
            const s = command.settlement;
            const amount = money(s.amount, doc.figures.scale, "settlement.amount");
            const settlement = { ...s, amount: amount.toString() };
            const existing = doc.settlements.find((x) => x.id === s.id);
            if (existing) {
                if (canonical({ ...existing, reversed: undefined }) === canonical(settlement)) return [];
                throw new InvoiceError("duplicate-id", "settlement.id", `settlement ${s.id} exists with other values`);
            }
            if (!isDate(s.date)) throw new InvoiceError("invalid-date", "settlement.date", `${s.date} is not a calendar date`);
            const outstanding = dec(balance(doc).outstanding);
            if (amount.cmp(outstanding) > 0) {
                throw new InvoiceError("overpayment", "settlement.amount", `${s.amount} exceeds the outstanding ${outstanding}`);
            }
            return [{ type: "settled", settlement }];
        }

        case "reverse-settlement": {
            const doc = expect(state, ["issued"], command);
            const s = doc.settlements.find((x) => x.id === command.settlementId);
            if (!s) throw new InvoiceError("not-found", "settlementId", `no settlement ${command.settlementId}`);
            if (s.reversed) return [];
            if (s.kind === "credit") {
                throw new InvoiceError("invalid-transition", "settlementId", "a credit stays applied while its credit note stands; undoing a credit note is not built yet");
            }
            return [{ type: "settlement-reversed", settlementId: s.id, reason: command.reason, at: ctx.now }];
        }

        case "request-delivery": {
            const doc = expect(state, ["issued"], command);
            const d = command.delivery;
            if (doc.deliveries.some((x) => x.id === d.id)) return [];
            if (!d.to) throw new InvoiceError("missing-field", "delivery.to", "a delivery needs a recipient");
            return [{ type: "delivery-requested", delivery: { ...d, requestedAt: ctx.now } }];
        }

        case "complete-delivery": {
            const doc = expect(state, ["issued", "void"], command);
            const d = doc.deliveries.find((x) => x.id === command.deliveryId);
            if (!d) throw new InvoiceError("not-found", "deliveryId", `no delivery ${command.deliveryId}`);
            if (d.outcome) {
                if (d.outcome.status === command.status) return [];
                throw new InvoiceError("invalid-transition", "status", `delivery ${d.id} already ${d.outcome.status}`);
            }
            return [
                {
                    type: "delivery-completed",
                    deliveryId: d.id,
                    status: command.status,
                    at: ctx.now,
                    ...(command.detail !== undefined && { detail: command.detail }),
                },
            ];
        }
    }
}

export function evolve(state: DocumentState | undefined, event: DocumentEvent): DocumentState {
    if (event.type === "created") return { id: event.id, version: 1, status: "draft", data: event.data };
    if (!state) throw new Error(`event ${event.type} has no document to apply to`);
    const version = state.version + 1;

    switch (event.type) {
        case "updated":
            return { ...state, version, data: event.data };
        case "discarded":
            return { id: state.id, version, status: "discarded", data: state.data };
        case "issued":
            return {
                id: state.id,
                version,
                status: "issued",
                data: state.data,
                number: event.number,
                issueDate: event.issueDate,
                dueDate: event.dueDate,
                figures: event.figures,
                settlements: [],
                deliveries: [],
            };
        case "voided":
            return { ...issued(state), version, status: "void", voided: { reason: event.reason, at: event.at } };
        case "settled": {
            const doc = issued(state);
            return { ...doc, version, settlements: [...doc.settlements, event.settlement] };
        }
        case "settlement-reversed": {
            const doc = issued(state);
            const reversed = { reason: event.reason, at: event.at };
            return {
                ...doc,
                version,
                settlements: doc.settlements.map((s): Settlement => (s.id === event.settlementId ? { ...s, reversed } : s)),
            };
        }
        case "delivery-requested": {
            const doc = issued(state);
            return { ...doc, version, deliveries: [...doc.deliveries, event.delivery] };
        }
        case "delivery-completed": {
            const doc = issuedOrVoid(state);
            const outcome = { status: event.status, at: event.at, ...(event.detail !== undefined && { detail: event.detail }) };
            return { ...doc, version, deliveries: doc.deliveries.map((d) => (d.id === event.deliveryId ? { ...d, outcome } : d)) };
        }
    }
}

function issue(data: DraftData, number: string, ctx: Context): DocumentEvent {
    if (!number) throw new InvoiceError("missing-field", "number", "issuing needs a number from the backend's sequence");
    const { policy, pack } = ctx.registry.resolve(data.policy);
    const issueDate = issueDateOf(data, ctx);
    if (!isDate(issueDate)) throw new InvoiceError("invalid-date", "data.issueDate", `${issueDate} is not a calendar date`);
    const dueDate = data.due === undefined ? issueDate : "date" in data.due ? data.due.date : addDays(issueDate, data.due.days);
    if (!isDate(dueDate)) throw new InvoiceError("invalid-date", "data.due", `due date ${dueDate} is out of range`);
    if (daysBetween(issueDate, dueDate) < 0) throw new InvoiceError("invalid-date", "data.due", `due ${dueDate} is before issue ${issueDate}`);

    const known = pack.taxCategories;
    const taxes = [
        ...data.lines.flatMap((l, i) => l.taxes.map((t, j) => [t.category, `data.lines[${i}].taxes[${j}].category`] as const)),
        ...(data.allowances ?? []).flatMap((a, i) => a.taxes.map((t, j) => [t.category, `data.allowances[${i}].taxes[${j}].category`] as const)),
        ...(data.charges ?? []).flatMap((c, i) => c.taxes.map((t, j) => [t.category, `data.charges[${i}].taxes[${j}].category`] as const)),
    ];
    for (const [category, path] of taxes) {
        if (!Object.hasOwn(known, category)) throw new InvoiceError("invalid-tax", path, `${pack.id} has no tax category ${category}`);
    }

    let computed;
    try {
        computed = compute(data, policy);
    } catch (e) {
        throw e instanceof InvoiceError ? e.under("data") : e;
    }
    const violations = verify(computed);
    if (violations.length) {
        throw new InvoiceError("verification-failed", "", violations.map((v) => `${v.rule}: ${v.message}`).join("; "));
    }
    if (computed.totals.payable.sign() < 0) {
        throw data.kind === "credit-note"
            ? new InvoiceError("invalid-amount", "data.lines", "a credit note's lines carry positive quantities: the note itself is the credit")
            : new InvoiceError("unsupported", "data.lines", "an invoice with a negative total; credit the original invoice instead");
    }
    const figures = toFigures(computed);
    const failed = pack.rules.filter((r) => !r.check({ data, figures }));
    if (failed.length) throw new InvoiceError("rule-failed", "", failed.map((r) => `${r.id}: ${r.message}`).join("; "));
    return { type: "issued", number, issueDate, dueDate, figures };
}

function validateDraft(data: DraftData, ctx: Context): void {
    ctx.registry.resolve(data.policy);
    try {
        minorUnits(data.currency);
    } catch (e) {
        throw e instanceof InvoiceError ? e.under("data") : e;
    }
    if (data.issueDate !== undefined && !isDate(data.issueDate)) {
        throw new InvoiceError("invalid-date", "data.issueDate", `${data.issueDate} is not a calendar date`);
    }
    if (data.due && "date" in data.due && !isDate(data.due.date)) {
        throw new InvoiceError("invalid-date", "data.due.date", `${data.due.date} is not a calendar date`);
    }
    if (data.due && "days" in data.due && !(Number.isInteger(data.due.days) && data.due.days >= 0 && data.due.days <= MAX_TERMS)) {
        throw new InvoiceError("invalid-date", "data.due.days", `payment terms are a whole number of days, at most ${MAX_TERMS}`);
    }
    if (data.kind === "credit-note" && !data.corrects) {
        throw new InvoiceError("missing-field", "data.corrects", "a credit note names the invoice it corrects");
    }
}

function expect<S extends DocumentState["status"]>(
    state: DocumentState,
    allowed: readonly S[],
    command: Command,
): Extract<DocumentState, { status: S }> {
    if (!(allowed as readonly string[]).includes(state.status)) {
        throw new InvoiceError("invalid-transition", "", `cannot ${command.type} a ${state.status} document`);
    }
    return state as Extract<DocumentState, { status: S }>;
}

function issued(state: DocumentState): IssuedState {
    if (state.status !== "issued") throw new Error(`document ${state.id} is ${state.status}, not issued`);
    return state;
}

function issuedOrVoid(state: DocumentState): IssuedState | VoidState {
    if (state.status !== "issued" && state.status !== "void") throw new Error(`document ${state.id} was never issued`);
    return state;
}

/** A positive amount within the currency's decimals, normalised to them. */
function money(value: string, scale: number, path: string) {
    let d;
    try {
        d = dec(value);
    } catch {
        throw new InvoiceError("invalid-amount", path, `${value} is not a decimal amount`);
    }
    const scaled = d.round(scale, "toward-zero");
    if (!scaled.eq(d)) throw new InvoiceError("too-many-decimals", path, `${value} has more than ${scale} decimals`);
    if (scaled.sign() <= 0) throw new InvoiceError("invalid-amount", path, "a settlement is a positive amount");
    return scaled;
}

/** JSON with sorted keys and undefined dropped: equal for equal data, whatever the key order. */
function canonical(value: unknown): string {
    return JSON.stringify(value, (_key, v: unknown) =>
        v && typeof v === "object" && !Array.isArray(v)
            ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
            : v,
    );
}
