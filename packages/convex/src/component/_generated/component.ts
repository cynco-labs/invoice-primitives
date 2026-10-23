/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * `npx convex codegen` writes this type from a deployment's analysis of the
 * component. Without a deployment it is derived here from the function
 * modules' own types, which carry the same argument and return types (see
 * README, "Codegen"). The CLI replaces this file when an app that installs the
 * component runs `npx convex dev`.
 * @module
 */
import type { FunctionReference, RegisteredMutation, RegisteredQuery } from "convex/server";
import type * as lib from "../lib.ts";

type Reference<F, Name extends string | undefined> =
    F extends RegisteredMutation<"public", infer Args, infer Returns>
        ? FunctionReference<"mutation", "internal", Args, Awaited<Returns>, Name>
        : F extends RegisteredQuery<"public", infer Args, infer Returns>
          ? FunctionReference<"query", "internal", Args, Awaited<Returns>, Name>
          : never;

type Functions<Module, Name extends string | undefined> = {
    [K in keyof Module as Reference<Module[K], Name> extends never ? never : K]: Reference<Module[K], Name>;
};

/**
 * A utility for referencing the component's exposed API.
 *
 * Useful when expecting a parameter like `components.invoicing`.
 */
export type ComponentApi<Name extends string | undefined = string | undefined> = {
    lib: Functions<typeof lib, Name>;
};
