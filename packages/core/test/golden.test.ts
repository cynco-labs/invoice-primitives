/**
 * A published policy id promises the same figures forever. These files pin the
 * output of every policy a pack publishes; a change to one is a breaking change
 * that needs a new policy id, not an updated snapshot.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compute, CORE } from "../src/index.ts";
import { eu } from "../src/packs/eu.ts";
import { jp } from "../src/packs/jp.ts";
import { my } from "../src/packs/my.ts";
import type { InvoiceInput } from "../src/calc/model.ts";

const INPUTS: Record<string, (currency: string, t: [string, string]) => InvoiceInput> = {
    mixed: (currency, [a, b]) => ({
        currency,
        lines: [
            { id: "1", quantity: "3", price: "33.33", taxes: [{ category: a, rate: "8" }] },
            { id: "2", quantity: "1.5", price: "19.99", allowances: [{ percent: "10", base: currency === "JPY" ? "30" : "29.99" }], taxes: [{ category: b, rate: "10" }] },
            { id: "3", quantity: "-1", price: "33.33", taxes: [{ category: a, rate: "8" }] },
            { id: "4", quantity: "7", price: "0.07", taxes: [{ category: a, rate: "8" }] },
        ],
    }),
};

const PACKS = { eu: [eu, "EUR", ["S", "S"]], my: [my, "MYR", ["SA", "SE"]], jp: [jp, "JPY", ["AA", "S"]] } as const;

describe("golden outputs per published policy", () => {
    it("core version matches package.json", () => {
        const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { name: string; version: string };
        expect(CORE).toBe(`${pkg.name}@${pkg.version}`);
    });

    for (const [packName, [pack, currency, cats]] of Object.entries(PACKS)) {
        for (const [policyName, policy] of Object.entries(pack.policies)) {
            it(`${policy.id}`, async () => {
                const results = Object.fromEntries(
                    Object.entries(INPUTS).map(([name, make]) => {
                        const out = compute(make(currency, [...cats]), policy);
                        return [name, { lines: out.lines.map((l) => [l.id, l.net]), taxes: out.taxes, totals: out.totals }];
                    }),
                );
                await expect(JSON.stringify(results, null, 2)).toMatchFileSnapshot(`golden/${packName}.${policyName}.json`);
            });
        }
    }
});

