import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { vDocumentEvent, vDocumentState, vNumbering, vParty } from "./validators.ts";

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

    /** Each tenant's log: positions 1, 2, 3... with no gaps. The last row is the log's head. */
    events: defineTable({
        tenant: v.string(),
        position: v.number(),
        documentId: v.string(),
        version: v.number(),
        at: v.string(),
        event: vDocumentEvent,
    }).index("by_tenant_and_position", ["tenant", "position"]),

    /** Each tenant's settings (core's `Settings`). */
    settings: defineTable({
        tenant: v.string(),
        country: v.optional(v.string()),
        seller: v.optional(vParty),
        currency: v.optional(v.string()),
        timeZone: v.optional(v.string()),
        numbering: v.optional(vNumbering),
    }).index("by_tenant", ["tenant"]),

    /** The last number taken in each numbering series ("INV-2026-"). */
    sequences: defineTable({
        tenant: v.string(),
        series: v.string(),
        last: v.number(),
    }).index("by_tenant_and_series", ["tenant", "series"]),
});
