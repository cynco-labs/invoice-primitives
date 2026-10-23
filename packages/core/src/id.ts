/**
 * Every runtime this library targets (Node 19+, Workers, Convex, browsers) has
 * `crypto.randomUUID`; declaring just that keeps the core free of DOM and Node types.
 */
declare const crypto: { randomUUID(): string };

export const newId = (): string => crypto.randomUUID();
