import { convexValidators } from "@invoice-primitives/core/schema";
import { expect, it } from "vitest";
import generated from "../src/component/shapes.generated.ts?raw";

it("the Convex validators are what `pnpm gen` writes from core's shapes", () => {
    expect(generated).toBe(convexValidators());
});
