import { describe, expect, it } from "vitest";
import { createRegistry } from "../src/backend.ts";
import { valuesAt } from "../src/pack.ts";
import { bundledPacks, createMemoryBooks, InvoiceError, type CountryPack } from "../src/index.ts";
import { my } from "../src/packs/my.ts";
import { sampleInvoice } from "../src/testing/conformance.ts";

const code = (fn: () => unknown) => {
    try {
        fn();
    } catch (e) {
        return e instanceof InvoiceError ? `${e.code} ${e.path}` : String(e);
    }
    return "accepted";
};

/** Malaysia with one written rule: the buyer's TIN, in LHDN's shape. */
const strictMy: CountryPack = {
    ...my,
    id: "MY-STRICT",
    policies: { pint: { ...my.policies.pint!, id: "my-strict@1" } },
    defaults: { ...my.defaults, policy: "pint" },
    rules: [
        { id: "TIN-1", message: "the buyer has a TIN", source: "https://example.test/tin", check: { require: "data.buyer.ids[scheme=TIN].value" } },
        { id: "TIN-2", message: "a TIN is C, IG or similar followed by digits", source: "https://example.test/tin", check: { match: "data.buyer.ids[scheme=TIN].value", pattern: "[A-Z]{1,2}\\d{8,12}" } },
        { id: "CUR-1", message: "invoices are in ringgit", source: "https://example.test/cur", check: { oneOf: "data.currency", values: ["MYR"] } },
    ],
};

describe("packs are data", () => {
    it("every bundled pack survives JSON unchanged and registers from its JSON", () => {
        const json = JSON.parse(JSON.stringify(bundledPacks));
        expect(json).toEqual(bundledPacks);
        expect(code(() => createRegistry(json))).toBe("accepted");
    });

    it("a malformed pack is refused with a path, before any document uses it", () => {
        const { voiding: _, ...noVoiding } = my;
        expect(code(() => createRegistry(JSON.parse(JSON.stringify([noVoiding]))))).toBe("missing-field packs[0].voiding");
        expect(code(() => createRegistry([{ ...my, defaults: { policy: "nope" } }]))).toBe("invalid-argument packs[0].defaults.policy");
        expect(code(() => createRegistry([my, my]))).toBe("invalid-argument packs[1].id");
        const withRule = (check: CountryPack["rules"][number]["check"]) => ({ ...strictMy, rules: [{ ...strictMy.rules[0]!, check }] });
        expect(code(() => createRegistry([withRule({ match: "data.currency", pattern: "(" })]))).toBe("invalid-argument packs[0].rules[0].check.pattern");
        expect(code(() => createRegistry([withRule({ require: "data.buyer.ids[scheme=TIN.value" })]))).toBe("invalid-argument packs[0].rules[0].check.require");
        expect(code(() => createRegistry([withRule({ require: "buyer.name" })]))).toBe("invalid-argument packs[0].rules[0].check.require");
        expect(code(() => createRegistry([withRule({ oneOf: "data.currency.", values: [] })]))).toBe("invalid-argument packs[0].rules[0].check.oneOf");
        expect(code(() => createRegistry([{ ...strictMy, defaults: { ...strictMy.defaults, timeZone: "Mars/Base" } }]))).toBe("invalid-argument packs[0].defaults.timeZone");
        expect(code(() => createRegistry([{ ...strictMy, defaults: { ...strictMy.defaults, currency: "ABC" } }]))).toBe("unknown-currency packs[0].defaults.currency");
        const badTax = { ...strictMy, taxes: { odd: { label: "Odd", taxes: [{ category: "ZZ", rate: "1" }], source: "x", checked: "2026-10-23" } } };
        expect(code(() => createRegistry([badTax]))).toBe("invalid-tax packs[0].taxes.odd.taxes[0].category");
        expect(code(() => createRegistry([{ ...strictMy, taxes: { _hidden: my.taxes.exempt! } }]))).toBe("invalid-argument packs[0].taxes._hidden");
    });

    it("finds values by path, through lists and filters, and only own fields", () => {
        const data = { buyer: { ids: [{ scheme: "BRN", value: "1" }, { scheme: "TIN", value: "C123" }, { scheme: "VAT.EU", value: "FR1" }] }, due: { days: 30 } };
        expect(valuesAt({ data }, "data.buyer.ids[scheme=TIN].value")).toEqual(["C123"]);
        expect(valuesAt({ data }, "data.buyer.ids[scheme=VAT.EU].value")).toEqual(["FR1"]);
        expect(valuesAt({ data }, "data.buyer.ids[].value")).toEqual(["1", "C123", "FR1"]);
        expect(valuesAt({ data }, "data.seller.name")).toEqual([]);
        expect(valuesAt({ data }, "data.constructor")).toEqual([]);
        expect(valuesAt({ data }, "data.due.days")).toEqual([30]);
    });

    it("require counts only a real value: not blank, not an empty list", async () => {
        const rules = (check: CountryPack["rules"][number]["check"]) => [{ id: "R", message: "m", source: "s", check }];
        const books = createMemoryBooks({ packs: [...bundledPacks, { ...strictMy, rules: [...rules({ require: "data.buyer.ids" }), ...rules({ require: "data.buyer.email" })] }] });
        const policy = "my-strict@1";
        await books.create({ id: "empty", ...sampleInvoice({ policy, buyer: { name: "A", ids: [], email: " " } }) });
        await expect(books.issue("empty")).rejects.toMatchObject({ code: "rule-failed", detail: "R: m; R: m" });
        await books.create({ id: "given", ...sampleInvoice({ policy, buyer: { name: "A", ids: [{ scheme: "TIN", value: "C1" }], email: "a@b.test" } }) });
        expect((await books.issue("given")).status).toBe("issued");
    });

    it("match and oneOf read numbers too", async () => {
        const terms = { id: "T", message: "terms are 30 or 60 days", source: "s", check: { oneOf: "data.due.days", values: ["30", "60"] } } as const;
        const books = createMemoryBooks({ packs: [...bundledPacks, { ...strictMy, rules: [terms] }] });
        await books.create({ id: "a", ...sampleInvoice({ policy: "my-strict@1", due: { days: 30 } }) });
        expect((await books.issue("a")).status).toBe("issued");
        await books.create({ id: "b", ...sampleInvoice({ policy: "my-strict@1", due: { days: 45 } }) });
        await expect(books.issue("b")).rejects.toMatchObject({ code: "rule-failed" });
    });

    it("a pack's rules decide whether a document may be issued", async () => {
        const books = createMemoryBooks({ packs: [...bundledPacks, strictMy], timeZone: "Asia/Kuala_Lumpur" });
        const policy = "my-strict@1";
        await books.create({ id: "no-tin", ...sampleInvoice({ policy }) });
        await expect(books.issue("no-tin")).rejects.toMatchObject({ code: "rule-failed", detail: "TIN-1: the buyer has a TIN" });
        await books.create({ id: "bad-tin", ...sampleInvoice({ policy, buyer: { name: "A", ids: [{ scheme: "TIN", value: "123" }] } }) });
        await expect(books.issue("bad-tin")).rejects.toMatchObject({ code: "rule-failed", detail: "TIN-2: a TIN is C, IG or similar followed by digits" });
        await books.create({ id: "ok", ...sampleInvoice({ policy, buyer: { name: "A", ids: [{ scheme: "TIN", value: "C1234567890" }] } }) });
        expect((await books.issue("ok")).status).toBe("issued");
    });
});
