/**
 * Test vectors: inputs and the outputs this core gives, as JSON, so an
 * implementation in any language can check itself against this one.
 * `pnpm gen` writes them to `vectors/`; `test/generated.test.ts` fails when
 * they drift from what the core computes.
 *
 *   calculation.json: { name, policy, input, output | refused }
 *   documents.json:   { name, now, timeZone, steps: [{ command, events | refused }] }
 *
 * Documents run on the bundled packs, one command after another, each on the
 * state the previous one left.
 */
import { compute } from "../calc/compute.ts";
import type { InvoiceInput, Policy } from "../calc/model.ts";
import { execute, type Context } from "../document/execute.ts";
import type { Command, DocumentEvent, DocumentState } from "../document/types.ts";
import { InvoiceError } from "../errors.ts";
import { copyJson } from "../json.ts";
import { registryFor } from "../pack.ts";
import { eu, jp, my } from "../packs/index.ts";
import { sampleInvoice } from "./conformance.ts";

type Refusal = { code: string; path: string };

export interface CalculationVector {
    name: string;
    policy: Policy;
    input: InvoiceInput;
    output?: { lines: [string, string][]; taxes: unknown[]; totals: Record<string, string> };
    refused?: Refusal;
}

export interface DocumentVector {
    name: string;
    now: string;
    timeZone: string;
    steps: { command: Command; events?: DocumentEvent[]; refused?: Refusal }[];
}

const HALF_UP = { amounts: "half-away-from-zero", tax: "half-away-from-zero" } as const;
const LINE: Policy = { id: "vector-line@1", taxRounding: "line", rounding: HALF_UP, pricesIncludeTax: false };
const RECONCILE: Policy = { id: "vector-reconcile@1", taxRounding: "document", rounding: { amounts: "half-away-from-zero", tax: "floor" }, pricesIncludeTax: "reconcile" };
const S = (rate: string) => ({ category: "S", rate });

const calculations: Omit<CalculationVector, "output" | "refused">[] = [
    {
        name: "mixed rates, a return and a percent allowance (PINT MY)",
        policy: my.policies.pint!,
        input: {
            currency: "MYR",
            lines: [
                { id: "1", quantity: "3", price: "33.33", taxes: [{ category: "SA", rate: "8" }] },
                { id: "2", quantity: "1.5", price: "19.99", allowances: [{ percent: "10", base: "29.99" }], taxes: [{ category: "SE", rate: "10" }] },
                { id: "3", quantity: "-1", price: "33.33", taxes: [{ category: "SA", rate: "8" }] },
                { id: "4", quantity: "7", price: "0.07", taxes: [{ category: "SA", rate: "8" }] },
            ],
        },
    },
    {
        name: "a document discount taxed by its category",
        policy: my.policies.pint!,
        input: {
            currency: "MYR",
            lines: [{ id: "1", quantity: "1", price: "1000.00", taxes: [{ category: "SA", rate: "8" }] }],
            allowances: [{ amount: "100.00", taxes: [{ category: "SA", rate: "8" }] }],
        },
    },
    {
        name: "cash rounding to 5 sen, recorded in BT-114",
        policy: my.policies.pintCash!,
        input: { currency: "MYR", lines: [{ id: "1", quantity: "1", price: "10.02", taxes: [{ category: "E" }] }] },
    },
    {
        name: "tourism tax: a fixed amount per room per night",
        policy: my.policies.pint!,
        input: {
            currency: "MYR",
            lines: [{ id: "1", quantity: "3", price: "200.00", taxes: [{ category: "SE", rate: "8" }, { category: "TTX", perUnit: "10.00" }] }],
        },
    },
    {
        name: "tax rounded once per category, not per line (EN 16931)",
        policy: eu.policies.en16931!,
        input: { currency: "EUR", lines: ["1", "2", "3"].map((id) => ({ id, quantity: "1", price: "0.10", taxes: [S("25")] })) },
    },
    {
        name: "tax rounded per line",
        policy: LINE,
        input: { currency: "EUR", lines: ["1", "2", "3"].map((id) => ({ id, quantity: "1", price: "0.10", taxes: [S("25")] })) },
    },
    {
        name: "Japan: tax-inclusive ¥333 at 10%, fractions truncated once per rate",
        policy: jp.policies.truncateInclusive!,
        input: { currency: "JPY", lines: [{ id: "1", quantity: "1", price: "333", taxes: [S("10")] }] },
    },
    {
        name: "Japan: reduced and standard rates in separate buckets",
        policy: jp.policies.truncate!,
        input: {
            currency: "JPY",
            lines: [
                { id: "1", quantity: "3", price: "108", taxes: [{ category: "AA", rate: "8" }] },
                { id: "2", quantity: "1", price: "1099", taxes: [S("10")] },
            ],
        },
    },
    {
        name: "inclusive prices reconciled to BR-CO-17, the residual in BT-114",
        policy: RECONCILE,
        input: { currency: "JPY", lines: [{ id: "1", quantity: "1", price: "1099", taxes: [S("10")] }] },
    },
    {
        name: "Kuwaiti dinar: three decimals",
        policy: eu.policies.en16931!,
        input: { currency: "KWD", lines: [{ id: "1", quantity: "3", price: "1.2345", taxes: [S("5")] }] },
    },
    {
        name: "refused: an amount with more decimals than the currency",
        policy: eu.policies.en16931!,
        input: { currency: "EUR", lines: [{ id: "1", quantity: "1", price: "1.00", taxes: [S("20")] }], prepaid: "0.001" },
    },
    {
        name: "refused: an unknown currency",
        policy: eu.policies.en16931!,
        input: { currency: "ABC", lines: [{ id: "1", quantity: "1", price: "1.00", taxes: [S("20")] }] },
    },
];

const draft = sampleInvoice();

const documentDefinitions: (Omit<DocumentVector, "steps"> & { commands: Command[] })[] = [
    {
        name: "issue, part-pay, refuse an overpayment, settle, reverse",
        now: "2026-10-23T02:00:00Z",
        timeZone: "Asia/Kuala_Lumpur",
        commands: [
            { type: "create", id: "inv", data: draft },
            { type: "issue", number: "INV-2026-00001" },
            { type: "issue", number: "INV-2026-00002" },
            { type: "settle", settlement: { id: "p1", kind: "payment", amount: "1000", date: "2026-10-25" } },
            { type: "settle", settlement: { id: "p2", kind: "payment", amount: "771.48", date: "2026-10-26" } },
            { type: "settle", settlement: { id: "p2", kind: "payment", amount: "771.47", date: "2026-10-26" } },
            { type: "settle", settlement: { id: "p2", kind: "payment", amount: "771.470", date: "2026-10-26" } },
            { type: "void", reason: "issued in error" },
            { type: "reverse-settlement", settlementId: "p2", reason: "bounced" },
        ],
    },
    {
        name: "a draft is edited and issued; an issued EN 16931 invoice can be neither voided nor discarded",
        now: "2026-10-23T02:00:00Z",
        timeZone: "Europe/Paris",
        commands: [
            { type: "create", id: "d", data: sampleInvoice({ policy: "en16931@1", currency: "EUR", lines: [{ id: "1", name: "x", quantity: "1", price: "10.00", taxes: [S("20")] }] }) },
            { type: "update", data: sampleInvoice({ policy: "en16931@1", currency: "EUR", note: "Thank you", lines: [{ id: "1", name: "x", quantity: "1", price: "10.00", taxes: [S("20")] }] }) },
            { type: "issue", number: "INV-2026-00001" },
            { type: "void", reason: "mistake" },
            { type: "discard" },
        ],
    },
    {
        name: "deliveries are requested once and completed once",
        now: "2026-10-23T02:00:00Z",
        timeZone: "Asia/Kuala_Lumpur",
        commands: [
            { type: "create", id: "inv", data: draft },
            { type: "issue", number: "INV-2026-00001" },
            { type: "request-delivery", delivery: { id: "e1", channel: "email", to: "ap@acme.example" } },
            { type: "request-delivery", delivery: { id: "e1", channel: "email", to: "ap@acme.example" } },
            { type: "complete-delivery", deliveryId: "e1", status: "delivered" },
            { type: "complete-delivery", deliveryId: "e1", status: "failed" },
        ],
    },
];

const refusal = (e: unknown): Refusal => {
    if (e instanceof InvoiceError) return { code: e.code, path: e.path };
    throw e;
};

/** What the core gives for a calculation vector: its output, or its refusal. */
export function runCalculation(v: Pick<CalculationVector, "policy" | "input">): Pick<CalculationVector, "output" | "refused"> {
    try {
        const out = compute(v.input, v.policy);
        // Amounts are Decimals; as JSON they are the decimal strings the vectors hold.
        const output: NonNullable<CalculationVector["output"]> = JSON.parse(JSON.stringify({ lines: out.lines.map((l) => [l.id, l.net]), taxes: out.taxes, totals: out.totals }));
        return { output };
    } catch (e) {
        return { refused: refusal(e) };
    }
}

/** What the core gives for each command of a document vector, run in order on the bundled packs. */
export function runDocument(v: Pick<DocumentVector, "now" | "timeZone">, commands: readonly Command[]): DocumentVector["steps"] {
    const ctx: Context = { now: v.now, timeZone: v.timeZone, registry: registryFor(undefined) };
    let state: DocumentState | undefined;
    return commands.map((command) => {
        try {
            const result = execute(state, command, ctx);
            state = result.state;
            return { command, events: copyJson(result.events) };
        } catch (e) {
            return { command, refused: refusal(e) };
        }
    });
}

export const calculationVectors = (): CalculationVector[] => calculations.map((v) => ({ ...v, ...runCalculation(v) }));

export const documentVectors = (): DocumentVector[] => documentDefinitions.map(({ commands, ...v }) => ({ ...v, steps: runDocument(v, commands) }));

export const vectorJson = (vectors: unknown) => `${JSON.stringify(vectors, null, 2)}\n`;
