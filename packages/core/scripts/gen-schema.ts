// Writes the generated files: `pnpm gen`. Tests fail when any is stale.
import { mkdirSync, writeFileSync } from "node:fs";
import { convexValidators, schemaJson } from "../src/schema/generate.ts";
import { calculationVectors, documentVectors, vectorJson } from "../src/testing/vectors.ts";

const write = (path: string, text: string) => {
    writeFileSync(new URL(path, import.meta.url), text);
    console.log(`wrote ${path.replace("../", "")}`);
};
mkdirSync(new URL("../vectors", import.meta.url), { recursive: true });
write("../schema/invoice-primitives.schema.json", schemaJson());
write("../../convex/src/component/shapes.generated.ts", convexValidators());
write("../vectors/calculation.json", vectorJson(calculationVectors()));
write("../vectors/documents.json", vectorJson(documentVectors()));
