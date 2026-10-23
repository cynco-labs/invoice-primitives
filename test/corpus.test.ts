import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dec, Decimal } from "../src/decimal.ts";
import { diffFile } from "../scripts/corpus-report.ts";
import { readUbl } from "./ubl.ts";

const dir = fileURLToPath(new URL("../corpus/", import.meta.url));
const files = existsSync(dir) ? readdirSync(dir).sort() : [];

/** Peppol R120: line net = quantity × price ÷ base quantity + charges − allowances. */
function statesLineArithmetic(path: string): boolean {
    const { input, stated } = readUbl(readFileSync(path, "utf8"));
    return input.lines.every((l, i) => {
        const sum = (xs: readonly { amount?: string }[] | undefined) => Decimal.sum((xs ?? []).map((x) => dec(x.amount ?? "0")));
        const net = dec(l.quantity)
            .mul(dec(l.price))
            .div(dec(l.baseQuantity ?? "1"), 2, "half-away-from-zero")
            .add(sum(l.charges))
            .sub(sum(l.allowances));
        return net.eq(dec(stated.lines[i]!.net));
    });
}

describe("official EN 16931 and Peppol BIS 3 examples", () => {
    it("corpus is present (pnpm corpus)", () => {
        expect(files.length).toBeGreaterThanOrEqual(28);
    });

    describe.each(files)("%s", (name) => {
        const path = `${dir}${name}`;

        it("document level: every total and tax subtotal matches the file", () => {
            expect(diffFile(path, "document")).toEqual([]);
        });

        it("line level: matches, unless the file's own lines break Peppol R120", () => {
            const diffs = diffFile(path, "line");
            if (statesLineArithmetic(path)) expect(diffs).toEqual([]);
            else expect(diffs.length).toBeGreaterThan(0);
        });
    });
});
