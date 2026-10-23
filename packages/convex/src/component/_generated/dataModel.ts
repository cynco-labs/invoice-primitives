/* eslint-disable */
/**
 * Generated data model types.
 *
 * Written by hand to match the output of `npx convex codegen` for a component
 * with a schema (see README, "Codegen"). The CLI regenerates this file when an
 * app that installs the component runs `npx convex dev`.
 * @module
 */
import type { DataModelFromSchemaDefinition, DocumentByName, TableNamesInDataModel, SystemTableNames } from "convex/server";
import type { GenericId } from "convex/values";
import schema from "../schema.ts";

/** The names of all of the component's tables. */
export type TableNames = TableNamesInDataModel<DataModel>;

/** The type of a document stored in Convex. */
export type Doc<TableName extends TableNames> = DocumentByName<DataModel, TableName>;

/** An identifier for a document in Convex. */
export type Id<TableName extends TableNames | SystemTableNames> = GenericId<TableName>;

/** The component's data model, derived from its schema. */
export type DataModel = DataModelFromSchemaDefinition<typeof schema>;
