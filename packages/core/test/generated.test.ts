/**
 * The generated files match the code that generates them (`pnpm gen`), the
 * JSON Schema accepts what the core produces and refuses what `parse`
 * refuses, and the vectors replay from their JSON alone.
 */
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { bundledPacks, createMemoryBooks, InvoiceError } from "../src/index.ts";
import { parse, schemaJson, shapes, type Schema } from "../src/schema/index.ts";
import { sampleInvoice } from "../src/testing/conformance.ts";
import { calculationVectors, documentVectors, runCalculation, runDocument, vectorJson, type CalculationVector, type DocumentVector } from "../src/testing/vectors.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("generated files", () => {
    it("are what `pnpm gen` writes", () => {
        expect(read("../schema/invoice-primitives.schema.json")).toBe(schemaJson());
        expect(read("../vectors/calculation.json")).toBe(vectorJson(calculationVectors()));
        expect(read("../vectors/documents.json")).toBe(vectorJson(documentVectors()));
    });
});

describe("JSON Schema", () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats.default(ajv);
    ajv.addSchema(JSON.parse(read("../schema/invoice-primitives.schema.json")));
    const valid = (name: string, value: unknown) => {
        const ok = ajv.validate(`${JSON.parse(schemaJson()).$id}#/$defs/${name}`, value);
        return ok ? "valid" : ajv.errorsText();
    };

    it("accepts every state, event and pack the core produces", async () => {
        const books = createMemoryBooks({ timeZone: "Asia/Kuala_Lumpur" });
        await books.create({ id: "a", customer: "c", ...sampleInvoice() });
        await books.issue("a");
        await books.settle("a", { id: "p", kind: "payment", amount: "10.00", date: "2026-10-25" });
        await books.requestDelivery("a", { id: "e", channel: "email", to: "x@example.test" });
        await books.credit("a", { id: "cn", input: { lines: [{ name: "x", quantity: "1", price: "1.00", taxes: [{ category: "E" }] }] } });
        await books.create({ id: "d", ...sampleInvoice() });
        await books.discard("d");
        for (const id of ["a", "cn", "d"]) expect(valid("DocumentState", await books.get(id))).toBe("valid");
        for (const e of await books.events()) expect(valid("StoredEvent", e)).toBe("valid");
        expect(valid("ListPage", await books.list())).toBe("valid");
        for (const pack of bundledPacks) expect(valid("CountryPack", JSON.parse(JSON.stringify(pack)))).toBe("valid");
        for (const v of calculationVectors()) expect(valid("InvoiceInput", v.input)).toBe("valid");
    });

    it("refuses what parse refuses", () => {
        const bad: [Schema<unknown>, string, unknown][] = [
            [shapes.NewDocument, "NewDocument", { buyer: { name: "A" }, lines: [{ name: "x", quantity: 10, price: "1.00" }] }],
            [shapes.NewDocument, "NewDocument", { buyer: { name: "A" }, lines: [], stray: true }],
            [shapes.NewDocument, "NewDocument", { buyer: { name: "" }, lines: [] }],
            [shapes.Adjustment, "Adjustment", { amount: "1.00", percent: "x" }],
            [shapes.Settings, "Settings", { numbering: { invoice: { prefix: "I-", digits: 1.5 }, "credit-note": { prefix: "C-", digits: 2 } } }],
            [shapes.ListQuery, "ListQuery", { status: "late" }],
            [shapes.NewSettlement, "NewSettlement", { id: "p", kind: "payment", amount: "1", date: "2026-02-30" }],
        ];
        for (const [schema, name, value] of bad) {
            expect(() => parse(schema, value), name).toThrow(InvoiceError);
            expect(valid(name, value), name).not.toBe("valid");
        }
    });
});

describe("vectors, read back from JSON", () => {
    it("calculation", () => {
        const vectors = JSON.parse(read("../vectors/calculation.json")) as CalculationVector[];
        expect(vectors.length).toBeGreaterThan(10);
        for (const v of vectors) expect(runCalculation(v), v.name).toEqual(v.output ? { output: v.output } : { refused: v.refused });
    });

    it("documents", () => {
        const vectors = JSON.parse(read("../vectors/documents.json")) as DocumentVector[];
        for (const v of vectors) expect(runDocument(v, v.steps.map((s) => s.command)), v.name).toEqual(v.steps);
    });
});
