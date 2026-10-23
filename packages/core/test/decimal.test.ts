import { describe, expect, it } from "vitest";
import { dec, ROUNDING_MODES } from "../src/money/decimal.ts";

const MODES = ROUNDING_MODES;

describe("Decimal", () => {
    it.each([
        // value, then results in MODES order
        ["2.5", ["3", "2", "2", "3", "2", "2", "3"]],
        ["-2.5", ["-3", "-2", "-2", "-3", "-2", "-3", "-2"]],
        ["3.5", ["4", "4", "3", "4", "3", "3", "4"]],
        ["2.4", ["2", "2", "2", "3", "2", "2", "3"]],
        ["-2.6", ["-3", "-3", "-3", "-3", "-2", "-3", "-2"]],
        ["1.005", ["1", "1", "1", "2", "1", "1", "2"]],
    ] as const)("rounds %s to an integer in every mode", (value, expected) => {
        expect(MODES.map((m) => dec(value).round(0, m).toString())).toEqual(expected);
    });

    it("rounds 1.005 to 1.01 half away from zero, where binary floats give 1.00", () => {
        expect(dec("1.005").round(2, "half-away-from-zero").toString()).toBe("1.01");
        expect(dec("-1.005").round(2, "half-away-from-zero").toString()).toBe("-1.01");
    });

    it("multiplies and adds exactly", () => {
        expect(dec("0.1").add(dec("0.2")).toString()).toBe("0.3");
        expect(dec("3690.00").mul(dec("16.15")).toString()).toBe("59593.5000");
    });

    it("divides to a stated scale", () => {
        expect(dec("1").div(dec("3"), 4, "half-even").toString()).toBe("0.3333");
        expect(dec("333").mul(dec("10")).div(dec("110"), 0, "floor").toString()).toBe("30");
        expect(dec("-7").div(dec("2"), 0, "half-even").toString()).toBe("-4");
    });

    it("rounds to a cash increment", () => {
        expect(dec("10.02").roundTo(dec("0.05"), "half-away-from-zero").toString()).toBe("10.00");
        expect(dec("10.03").roundTo(dec("0.05"), "half-away-from-zero").toString()).toBe("10.05");
        expect(dec("10.08").roundTo(dec("0.05"), "half-away-from-zero").toString()).toBe("10.10");
    });

    it("refuses anything but a plain decimal string", () => {
        for (const bad of ["1e3", "", "1.", ".5", "1,000.00", "NaN", "0x10"]) expect(() => dec(bad)).toThrow(TypeError);
    });

    it("normalizes trailing zeros and keeps scale otherwise", () => {
        expect(dec("25.000").normalize().toString()).toBe("25");
        expect(dec("1300.00").toString()).toBe("1300.00");
        expect(JSON.stringify({ a: dec("-0.05") })).toBe('{"a":"-0.05"}');
    });
});
