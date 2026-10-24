import { createMemoryBooks } from "../src/memory.ts";
import { booksConformance } from "../src/testing/conformance.ts";

booksConformance("memory", (options) => createMemoryBooks({ ...options, timeZone: "Asia/Kuala_Lumpur" }));
