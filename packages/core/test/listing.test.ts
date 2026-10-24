import { describe, expect, it } from "vitest";
import { createBooks, memoryStore, type Listing } from "../src/backend.ts";
import { collect, listFilter } from "../src/document/listing.ts";
import { createMemoryBooks, type DraftData } from "../src/index.ts";
import { sampleInvoice } from "../src/testing/conformance.ts";

describe("listing", () => {
    it("judges overdue by the seller's calendar, not UTC's", () => {
        // 17:00 UTC on the 23rd is already the 24th in Kuala Lumpur.
        const ctx = { now: "2026-10-23T17:00:00Z", timeZone: "Asia/Kuala_Lumpur" };
        expect(listFilter({ status: "overdue" }, ctx).dueBefore).toBe("2026-10-24");
        expect(listFilter({ status: "overdue" }, { ...ctx, timeZone: "UTC" }).dueBefore).toBe("2026-10-23");
        expect(listFilter({ status: "overdue", asOf: "2026-01-01" }, ctx).dueBefore).toBe("2026-01-01");
    });

    it("a document due yesterday in the seller's time zone is overdue, though not yet in UTC", async () => {
        const books = createMemoryBooks({ now: () => "2026-10-23T17:00:00Z", timeZone: "Asia/Kuala_Lumpur" });
        const due: Partial<DraftData> = { issueDate: "2026-10-01", due: { date: "2026-10-23" } };
        await books.create({ id: "a", ...sampleInvoice(due) });
        await books.issue("a");
        expect((await books.list({ status: "overdue" })).documents.map((d) => d.id)).toEqual(["a"]);
        expect((await books.list({ status: "overdue", asOf: "2026-10-23" })).documents).toEqual([]);
    });

    it("a credit note takes its invoice's customer; one slipped into its input is refused", async () => {
        const books = createMemoryBooks({ timeZone: "Asia/Kuala_Lumpur" });
        await books.create({ id: "inv", ...sampleInvoice() });
        await books.issue("inv");
        const input = JSON.parse('{"customer":"someone-else","issueDate":"2026-10-30","lines":[{"name":"x","quantity":"1","price":"1.00","taxes":[{"category":"E"}]}]}');
        await expect(books.credit("inv", { id: "cn", input })).rejects.toMatchObject({ code: "invalid-argument", path: "note.input.customer" });
        expect((await books.list({ customer: "someone-else" })).documents).toEqual([]);
    });

    it("a page that reaches the scan cap stops short with a cursor, and the next resumes after it", async () => {
        const ctx = { now: "2026-10-23T02:00:00Z", timeZone: "UTC" };
        const rows: (Listing & { seq: number })[] = [5, 4, 3, 2, 1].map((seq) => ({ seq, kind: "invoice", stage: seq % 2 ? "open" : "draft" }));
        const pages: { seqs: number[]; next?: string }[] = [];
        let cursor: string | undefined;
        do {
            const filter = listFilter({ status: "open", ...(cursor !== undefined && { cursor }) }, ctx);
            // As a store's scan does: only rows below the cursor.
            const page = await collect(rows.filter((r) => filter.before === undefined || r.seq < filter.before), filter, 2);
            pages.push({ seqs: page.rows.map((r) => r.seq), ...(page.next !== undefined && { next: page.next }) });
            cursor = page.next;
        } while (cursor !== undefined);
        expect(pages).toEqual([{ seqs: [5], next: "4" }, { seqs: [3], next: "2" }, { seqs: [1] }]);
    });
});

describe("a store with a read budget", () => {
    it("cuts pages of list, events and rebuildListings to it, and each continues from its cursor", async () => {
        const books = createBooks({ ...memoryStore({ timeZone: "UTC" }), maxDocuments: 2 });
        for (const id of ["a", "b", "c", "d", "e"]) await books.create({ id, ...sampleInvoice() });
        const listed: string[] = [];
        for (let page = await books.list({ limit: 50 }); ; page = await books.list({ limit: 50, cursor: page.next! })) {
            expect(page.documents.length).toBeLessThanOrEqual(2);
            listed.push(...page.documents.map((d) => d.id));
            if (page.next === undefined) break;
        }
        expect(listed).toEqual(["e", "d", "c", "b", "a"]);
        expect((await books.events(0, 100)).map((e) => e.position)).toEqual([1, 2]);
        expect((await books.events(2, 100)).map((e) => e.position)).toEqual([3, 4]);
        const pages = [await books.rebuildListings()];
        while (pages.at(-1)!.next !== undefined) pages.push(await books.rebuildListings(pages.at(-1)!.next));
        expect(pages.length).toBe(3);
    });
});

describe("rebuildListings", () => {
    it("restores a listing that is wrong", async () => {
        const store = memoryStore({ timeZone: "UTC" });
        const books = createBooks(store);
        await books.create({ id: "a", customer: "c", ...sampleInvoice() });
        await store.transaction((tx) => tx.relist("a", { kind: "credit-note", stage: "void" }));
        expect((await books.list({ customer: "c" })).documents).toEqual([]);
        expect(await books.rebuildListings()).toEqual({});
        expect((await books.list({ customer: "c", status: "draft" })).documents.map((d) => d.id)).toEqual(["a"]);
    });
});
