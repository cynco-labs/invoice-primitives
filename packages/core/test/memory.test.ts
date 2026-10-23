import { createMemoryBooks } from "../src/memory.ts";
import { createRegistry } from "../src/pack.ts";
import { bundledPacks } from "../src/packs/index.ts";
import { booksConformance } from "../src/testing/conformance.ts";

booksConformance("memory", () => createMemoryBooks({ registry: createRegistry(bundledPacks), timeZone: "Asia/Kuala_Lumpur" }));
