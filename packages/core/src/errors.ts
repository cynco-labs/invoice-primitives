/**
 * Every refusal the core makes. `code` is stable for programs to branch on and
 * to translate; `path` points into the input ("lines[2].allowances[0].amount").
 */
export type InvoiceErrorCode =
    | "already-exists"
    | "not-found"
    | "invalid-transition"
    | "unknown-policy"
    | "invalid-date"
    | "invalid-amount"
    | "overpayment"
    | "credit-exceeds-outstanding"
    | "has-settlements"
    | "void-not-allowed"
    | "rule-failed"
    | "verification-failed"
    | "missing-field"
    | "duplicate-id"
    | "unknown-currency"
    | "empty-invoice"
    | "duplicate-line-id"
    | "invalid-base-quantity"
    | "invalid-tax"
    | "too-many-decimals"
    | "invalid-policy"
    | "rounding-conflict"
    | "unsupported";

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

    /** The same refusal, with its path nested under `prefix`. */
    under(prefix: string): InvoiceError {
        return new InvoiceError(this.code, this.path ? `${prefix}.${this.path}` : prefix, this.detail);
    }
}
