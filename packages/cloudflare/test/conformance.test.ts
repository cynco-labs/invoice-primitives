import { env } from "cloudflare:workers";
import { booksConformance } from "@invoice-primitives/core/testing";
import { booksFor } from "../src/index.ts";

let tenant = 0;

booksConformance("cloudflare durable object", async (options) => {
    const books = booksFor(env.INVOICING, `tenant-${++tenant}`, options);
    await books.configure({ timeZone: "Asia/Kuala_Lumpur" });
    return books;
});
