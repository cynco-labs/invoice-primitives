import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // Convex functions run in a V8 isolate, not Node: test them in one.
        environment: "edge-runtime",
        server: { deps: { inline: ["convex-test"] } },
    },
});
