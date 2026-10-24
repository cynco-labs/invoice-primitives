/**
 * The port a backend implements: one tenant's storage, with no business rules.
 * `createBooks(store)` builds `Books` on it, so every rule (numbering, unique
 * numbers, listings, the log, limits) runs once, in core, on every backend.
 *
 * A store keeps four things per tenant: settings, documents (each with its
 * listing and `seq`), numbering sequences, and the event log.
 */
import type { StoredEvent } from "./books.ts";
import type { Settings } from "./document/input.ts";
import type { ListFilter, Listing } from "./document/listing.ts";
import type { DocumentState } from "./document/types.ts";

export interface Store {
    /** Runs `work` atomically and isolated from every other write to this tenant: a throw undoes every write it made. */
    transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
    /** Runs `work` on a consistent view. It writes nothing. */
    read<T>(work: (tx: Reader) => Promise<T>): Promise<T>;
    /** The most listings one page of `list` reads, for a store whose `scan` leaves part of a filter to core. */
    maxScan?: number;
    /**
     * The most documents, or events, one read loads, for a store with a budget
     * on bytes read. A page of `list`, `events` or `rebuildListings` is cut to
     * it, and continues from its cursor.
     */
    maxDocuments?: number;
}

export interface ListingRow extends Listing {
    id: string;
    /** The log position of the document's first event. Orders `list`, newest first. */
    seq: number;
}

export interface Reader {
    settings(): Promise<Settings>;
    load(id: string): Promise<DocumentState | undefined>;
    /**
     * Listings in descending `seq`, below `filter.before` when it is set. A
     * store may apply `conditions(filter)` itself or leave them to core, which
     * checks every row it is given.
     */
    scan(filter: ListFilter): AsyncIterable<ListingRow> | Iterable<ListingRow>;
    /** The log after position `after`, at most `limit` events. */
    events(after: number, limit: number): Promise<StoredEvent[]>;
    /** The id of the document that holds `number`, if one does. */
    holder(number: string): Promise<string | undefined>;
    /** Documents in ascending id after `after`, at most `limit`: for rebuilding listings. */
    documents(after: string | undefined, limit: number): Promise<DocumentState[]>;
}

export interface Transaction extends Reader {
    saveSettings(settings: Settings): Promise<void>;
    /** Takes the next value of a numbering series: 1, 2, 3... */
    next(series: string): Promise<number>;
    /** The log's last position, 0 when it is empty. */
    head(): Promise<number>;
    /**
     * Saves a document, its listing and its events. `expected` is the version
     * the document was loaded at, undefined for a new one: a store refuses to
     * write over any other version. A new document's `seq` is the position of
     * its first event.
     */
    write(save: { state: DocumentState; expected: number | undefined; listing: Listing; events: StoredEvent[] }): Promise<void>;
    /** Replaces a document's listing, keeping its `seq`. */
    relist(id: string, listing: Listing): Promise<void>;
}
