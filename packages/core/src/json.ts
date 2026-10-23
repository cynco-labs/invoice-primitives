/** Plain JSON helpers shared by the schema, the books and the stores. */
import { InvoiceError } from "./errors.ts";

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A copy as JSON: what a serialising backend stores and returns. A value JSON cannot carry is refused at `path`. */
export function copyJson<T>(value: T, path = ""): T {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        throw new InvoiceError("invalid-argument", path, "not JSON: no functions, bigints or cycles");
    }
}
