/**
 * For backend authors: implement a `Store` and hand it to `createBooks`; core
 * runs every rule. `memoryStore` is the reference implementation, and
 * `booksConformance` in `@invoice-primitives/core/testing` is the suite a
 * store must pass. A store that queries in its own language (SQL) builds its
 * filter from `conditions`, and a store that keeps listings apart from
 * documents compares them with `sameListing`.
 */
export { createBooks } from "./books.ts";
export type { ListingRow, Reader, Store, Transaction } from "./store.ts";
export { memoryStore } from "./memory.ts";
export { decide, evolve, execute, type Context } from "./document/execute.ts";
export { conditions, listingOf, sameListing, type Condition, type ListFilter, type Listing } from "./document/listing.ts";
export { createRegistry, registryFor, type Registry } from "./pack.ts";
