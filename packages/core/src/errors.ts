/**
 * Every refusal the core makes. `code` is stable for programs to branch on and
 * to translate; `path` points into the input ("lines[2].allowances[0].amount").
 */
export const INVOICE_ERROR_CODES = [
    "already-exists",
    "not-found",
    "invalid-transition",
    "invalid-argument",
    "unknown-policy",
    "invalid-date",
    "invalid-amount",
    "overpayment",
    "credit-exceeds-outstanding",
    "has-settlements",
    "void-not-allowed",
    "rule-failed",
    "verification-failed",
    "missing-field",
    "duplicate-id",
    "duplicate-number",
    "unknown-currency",
    "empty-invoice",
    "duplicate-line-id",
    "invalid-base-quantity",
    "invalid-tax",
    "too-many-decimals",
    "invalid-policy",
    "rounding-conflict",
    "unsupported",
    "too-large",
] as const;

export type InvoiceErrorCode = (typeof INVOICE_ERROR_CODES)[number];

export function isInvoiceErrorCode(code: string): code is InvoiceErrorCode {
    return (INVOICE_ERROR_CODES as readonly string[]).includes(code);
}

/** A refusal as data, for a boundary that does not carry classes (a Convex function, an RPC call). */
export type Refusal = { code: InvoiceErrorCode; path: string; detail: string };

export class InvoiceError extends Error {
    override name = "InvoiceError";
    readonly code: InvoiceErrorCode;
    readonly path: string;
    /** The message without the path. */
    readonly detail: string;

    constructor(code: InvoiceErrorCode, path: string, detail: string) {
        super(path ? `${path}: ${detail}` : detail);
        this.code = code;
        this.path = path;
        this.detail = detail;
    }

    toJSON(): Refusal {
        return { code: this.code, path: this.path, detail: this.detail };
    }

    /** The refusal `data` carries, as an `InvoiceError`; undefined when it is not one. */
    static from(data: unknown): InvoiceError | undefined {
        if (typeof data !== "object" || data === null || !("code" in data && "path" in data && "detail" in data)) return undefined;
        const { code, path, detail } = data;
        return typeof code === "string" && isInvoiceErrorCode(code) && typeof path === "string" && typeof detail === "string" ? new InvoiceError(code, path, detail) : undefined;
    }

    /** The same refusal, with its path nested under `prefix`. */
    under(prefix: string): InvoiceError {
        return new InvoiceError(this.code, this.path ? `${prefix}.${this.path}` : prefix, this.detail);
    }
}
