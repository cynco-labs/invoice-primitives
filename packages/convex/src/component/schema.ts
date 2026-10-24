import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { vDocumentEvent, vDocumentState, vListing, vSettings } from "./validators.ts";

export default defineSchema({
    /** The current state of each document. `number` is copied out of `state` for lookup by number. */
    documents: defineTable({
        tenant: v.string(),
        documentId: v.string(),
        number: v.optional(v.string()),
        state: vDocumentState,
    })
        .index("by_tenant_and_documentId", ["tenant", "documentId"])
        .index("by_tenant_and_number", ["tenant", "number"]),

    /**
     * Core's `Listing` of each document, rewritten with it on every save, and
     * `seq`, the log position of the document's first event, which orders
     * `list`. Kept apart from `documents` so a list scans small rows and loads
     * only the documents it returns.
     */
    listings: defineTable({ tenant: v.string(), documentId: v.string(), seq: v.number(), ...vListing.fields })
        .index("by_tenant_and_documentId", ["tenant", "documentId"])
        .index("by_tenant_and_seq", ["tenant", "seq"])
        .index("by_tenant_and_kind_and_seq", ["tenant", "kind", "seq"])
        .index("by_tenant_and_stage_and_seq", ["tenant", "stage", "seq"])
        .index("by_tenant_and_customer_and_seq", ["tenant", "customer", "seq"]),

    /** Each tenant's log: positions 1, 2, 3... with no gaps. The last row is the log's head. */
    events: defineTable({
        tenant: v.string(),
        position: v.number(),
        /** Absent on events written before formats existed: those are format 1. */
        format: v.optional(v.number()),
        documentId: v.string(),
        version: v.number(),
        at: v.string(),
        event: vDocumentEvent,
    })
        .index("by_tenant_and_position", ["tenant", "position"])
        .index("by_tenant_and_documentId_and_position", ["tenant", "documentId", "position"]),

    /** Each tenant's settings (core's `Settings`). */
    settings: defineTable({ tenant: v.string(), ...vSettings.fields }).index("by_tenant", ["tenant"]),

    /** The last number taken in each numbering series ("INV-2026-"). */
    sequences: defineTable({
        tenant: v.string(),
        series: v.string(),
        last: v.number(),
    }).index("by_tenant_and_series", ["tenant", "series"]),
});
