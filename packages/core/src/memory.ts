/**
 * The reference store: one tenant's books in memory. Small enough to read in
 * one sitting, and the shape every other store follows. Transactions run one
 * at a time; a throw restores everything as it was.
 */
import { createBooks, type Books, type BooksOptions, type StoredEvent } from "./books.ts";
import { checkSettings, type Settings } from "./document/input.ts";
import type { DocumentState } from "./document/types.ts";
import { copyJson } from "./json.ts";
import { registryFor } from "./pack.ts";
import type { ListingRow, Reader, Store, Transaction } from "./store.ts";

export interface BooksConfig extends Settings, BooksOptions {}

/** Books in memory, configured with `config`'s settings. */
export function createMemoryBooks(config: BooksConfig = {}): Books {
    const { packs, now, ...settings } = config;
    return createBooks(memoryStore(checkSettings(settings, registryFor(packs))), { packs, now });
}

export function memoryStore(settings: Settings = {}): Store {
    let current: Settings = copyJson(settings);
    const docs = new Map<string, DocumentState>();
    const listings = new Map<string, ListingRow>();
    const sequences = new Map<string, number>();
    const numbers = new Map<string, string>();
    const log: StoredEvent[] = [];
    /** The open transaction's undo steps, newest last. */
    let journal: (() => void)[] | undefined;
    let queue: Promise<unknown> = Promise.resolve();

    /** Runs `work` after every earlier transaction has finished. */
    const serial = <T>(work: () => Promise<T>): Promise<T> => {
        const result = queue.then(work);
        queue = result.catch(() => undefined);
        return result;
    };

    const put = <K, V>(map: Map<K, V>, key: K, value: V) => {
        const had = map.has(key);
        const before = map.get(key);
        journal?.push(() => (had ? map.set(key, before!) : map.delete(key)));
        map.set(key, value);
    };

    const reader: Reader = {
        settings: async () => copyJson(current),
        load: async (id) => {
            const doc = docs.get(id);
            return doc && copyJson(doc);
        },
        // Listings are inserted in seq order, so newest first is the map backwards.
        *scan(filter) {
            for (const row of [...listings.values()].reverse()) if (filter.before === undefined || row.seq < filter.before) yield row;
        },
        events: async (after, limit) => copyJson(log.slice(after, after + limit)),
        holder: async (number) => numbers.get(number),
        documents: async (after, limit) =>
            [...docs.keys()]
                .filter((id) => after === undefined || id > after)
                .sort()
                .slice(0, limit)
                .map((id) => copyJson(docs.get(id)!)),
    };

    const tx: Transaction = {
        ...reader,
        saveSettings: async (next) => {
            const before = current;
            journal?.push(() => (current = before));
            current = copyJson(next);
        },
        next: async (series) => {
            const n = (sequences.get(series) ?? 0) + 1;
            put(sequences, series, n);
            return n;
        },
        head: async () => log.length,
        write: async ({ state, expected, listing, events }) => {
            if (docs.get(state.id)?.version !== expected) throw new Error(`document ${state.id} changed during the transaction`);
            put(docs, state.id, copyJson(state));
            if ("number" in state) put(numbers, state.number, state.id);
            put(listings, state.id, { ...listing, id: state.id, seq: listings.get(state.id)?.seq ?? events[0]!.position });
            const length = log.length;
            journal?.push(() => (log.length = length));
            log.push(...copyJson(events));
        },
        relist: async (id, listing) => {
            put(listings, id, { ...listing, id, seq: listings.get(id)!.seq });
        },
    };

    return {
        read: (work) => serial(() => work(reader)),
        transaction: (work) =>
            serial(async () => {
                journal = [];
                try {
                    return await work(tx);
                } catch (e) {
                    for (const undo of journal.reverse()) undo();
                    throw e;
                } finally {
                    journal = undefined;
                }
            }),
    };
}
