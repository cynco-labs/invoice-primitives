/**
 * Every refusal the core makes. `code` is stable for programs to branch on and
 * to translate; `path` points into the input ("lines[2].allowances[0].amount").
 */
export type InvoiceErrorCode =
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

    constructor(code: InvoiceErrorCode, path: string, message: string) {
        super(path ? `${path}: ${message}` : message);
        this.code = code;
        this.path = path;
    }
}
