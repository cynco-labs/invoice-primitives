import { eu } from "./eu.ts";
import { jp } from "./jp.ts";
import { my } from "./my.ts";

export { eu, jp, my };
export { jpPolicy } from "./jp.ts";

/** Every pack this package ships. */
export const bundledPacks = [eu, my, jp] as const;
