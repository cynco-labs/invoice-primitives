/* eslint-disable */
/**
 * Generated utilities for implementing server-side Convex query and mutation functions.
 *
 * Written by hand to match the output of `npx convex codegen` for a component
 * (see README, "Codegen"). The CLI regenerates this file when an app that
 * installs the component runs `npx convex dev`.
 * @module
 */
import type {
    ActionBuilder,
    HttpActionBuilder,
    MutationBuilder,
    QueryBuilder,
    GenericActionCtx,
    GenericMutationCtx,
    GenericQueryCtx,
    GenericDatabaseReader,
    GenericDatabaseWriter,
} from "convex/server";
import {
    actionGeneric,
    httpActionGeneric,
    queryGeneric,
    mutationGeneric,
    internalActionGeneric,
    internalMutationGeneric,
    internalQueryGeneric,
} from "convex/server";
import type { DataModel } from "./dataModel.ts";

export const query: QueryBuilder<DataModel, "public"> = queryGeneric;
export const internalQuery: QueryBuilder<DataModel, "internal"> = internalQueryGeneric;
export const mutation: MutationBuilder<DataModel, "public"> = mutationGeneric;
export const internalMutation: MutationBuilder<DataModel, "internal"> = internalMutationGeneric;
export const action: ActionBuilder<DataModel, "public"> = actionGeneric;
export const internalAction: ActionBuilder<DataModel, "internal"> = internalActionGeneric;
export const httpAction: HttpActionBuilder = httpActionGeneric;

export type QueryCtx = GenericQueryCtx<DataModel>;
export type MutationCtx = GenericMutationCtx<DataModel>;
export type ActionCtx = GenericActionCtx<DataModel>;
export type DatabaseReader = GenericDatabaseReader<DataModel>;
export type DatabaseWriter = GenericDatabaseWriter<DataModel>;
