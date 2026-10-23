import { env, runInDurableObject } from "cloudflare:test";
import { sampleInvoice } from "@invoice-primitives/core/testing";
import { expect, it } from "vitest";
import { booksFor, InvoicingBooks } from "../src/index.ts";

const ids = (page: { documents: readonly { id: string }[] }) => page.documents.map((d) => d.id);

it("lists documents written before listing existed, once the object starts again", async () => {
    const stub = env.INVOICING.getByName("written-before-listing");
    const books = booksFor(env.INVOICING, "written-before-listing");
    await books.configure({ timeZone: "Asia/Kuala_Lumpur" });
    await books.create({ id: "a", ...sampleInvoice() });
    await books.issue("a");
    await books.settle("a", { id: "p1", kind: "payment", amount: "1771.47", date: "2026-10-25" });
    await books.create({ id: "b", ...sampleInvoice({ customer: "c1" }) });

    await runInDurableObject(stub, async (_instance: InvoicingBooks, state) => {
        // Put the tables back as they were before listing and event formats.
        const sql = state.storage.sql;
        sql.exec("ALTER TABLE events DROP COLUMN format");
        sql.exec("CREATE TABLE old (id TEXT PRIMARY KEY, status TEXT NOT NULL, number TEXT UNIQUE, version INTEGER NOT NULL, state TEXT NOT NULL)");
        sql.exec("INSERT INTO old SELECT id, json_extract(state, '$.status'), number, version, state FROM documents");
        sql.exec("DROP TABLE documents");
        sql.exec("ALTER TABLE old RENAME TO documents");

        const restarted = new InvoicingBooks(state, env);
        const pages = await Promise.all([restarted.list(), restarted.list({ status: "settled" }), restarted.list({ customer: "c1" })]);
        expect(pages.map((o) => (o.ok ? ids(o.value) : o.error))).toEqual([["b", "a"], ["a"], ["b"]]);
        const log = await restarted.events();
        expect(log.ok && log.value.map((e) => e.format)).toEqual([1, 1, 1, 1]);
    });

    const issued = await books.issue("b");
    expect(issued.status === "issued" && issued.number).toBe("INV-2026-00002");
    expect(ids(await books.list({ status: "open" }))).toEqual(["b"]);
});

it("reads one page's rows for a page of the default list, not the tenant's", async () => {
    const tenant = "rows-read";
    const books = booksFor(env.INVOICING, tenant);
    for (let i = 0; i < 60; i++) await books.create({ id: `d${String(i).padStart(2, "0")}`, ...sampleInvoice() });
    await runInDurableObject(env.INVOICING.getByName(tenant), async (_instance: InvoicingBooks, state) => {
        const sql = state.storage.sql;
        const exec = sql.exec.bind(sql);
        const reads: (() => number)[] = [];
        const counted = new InvoicingBooks(state, env);
        sql.exec = function counting<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]) {
            const cursor = exec<T>(query, ...bindings);
            reads.push(() => cursor.rowsRead);
            return cursor;
        };
        const page = await counted.list({ limit: 3 });
        sql.exec = exec;
        expect(page.ok && page.value.documents.length).toBe(3);
        expect(reads.reduce((sum, rows) => sum + rows(), 0)).toBeLessThan(20);
    });
});
