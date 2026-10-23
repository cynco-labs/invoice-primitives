/**
 * An invoice is a draft until it is issued, and immutable after. Corrections
 * are new documents (a credit or debit note) that reference it; voiding is a
 * country's decision, asked of its pack.
 */
import { compute } from "./compute.ts";
import type { ComputedInvoice, InvoiceInput, Policy } from "./model.ts";
import { verify, type Violation } from "./verify.ts";

export type DocumentKind = "invoice" | "credit-note" | "debit-note";

export interface Draft {
    readonly state: "draft";
    readonly kind: DocumentKind;
    readonly input: InvoiceInput;
    /** BT-25: the invoice a note corrects. */
    readonly corrects?: string;
}

export interface Issued {
    readonly state: "issued";
    readonly kind: DocumentKind;
    /** BT-1. Allocated by the caller's numbering, so the core holds no counter. */
    readonly number: string;
    /** BT-2, ISO date. */
    readonly issueDate: string;
    readonly input: InvoiceInput;
    readonly computed: ComputedInvoice;
    readonly corrects?: string;
}

export interface Voided {
    readonly state: "void";
    readonly issued: Issued;
    readonly reason: string;
    readonly voidedAt: string;
}

export class InvalidInvoiceError extends Error {
    override name = "InvalidInvoiceError";
    readonly violations: Violation[];
    constructor(violations: Violation[]) {
        super(violations.map((v) => `${v.rule}: ${v.message} (expected ${v.expected}, got ${v.actual})`).join("; "));
        this.violations = violations;
    }
}

export function draft(kind: DocumentKind, input: InvoiceInput, corrects?: string): Draft {
    if (kind !== "invoice" && !corrects) throw new RangeError(`a ${kind} must reference the invoice it corrects`);
    return { state: "draft", kind, input, ...(corrects && { corrects }) };
}

/** Freezes a copy: the caller's draft, input and policy stay theirs to reuse. */
export function issue(d: Draft, policy: Policy, at: { number: string; issueDate: string }): Issued {
    const input = structuredClone(d.input);
    const computed = compute(input, policy);
    const violations = verify(computed);
    if (violations.length) throw new InvalidInvoiceError(violations);
    return deepFreeze({ ...d, input, state: "issued", number: at.number, issueDate: at.issueDate, computed });
}

export function voidInvoice(issued: Issued, reason: string, voidedAt: string): Voided {
    return deepFreeze({ state: "void", issued, reason, voidedAt });
}

function deepFreeze<T>(value: T): T {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const v of Object.values(value)) deepFreeze(v);
    }
    return value;
}
