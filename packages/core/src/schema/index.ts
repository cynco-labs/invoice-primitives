/**
 * The shapes every boundary uses, as data: check untyped input with `parse`,
 * or generate validators for another runtime from `shapes`.
 */
export { parse, jsonSchema, type Field, type Infer, type Node, type Schema } from "./dsl.ts";
export * as shapes from "./shapes.ts";
export { convexValidators, schemaJson, SCHEMA_ID } from "./generate.ts";
