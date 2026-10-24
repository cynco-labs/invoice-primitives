/**
 * Exact decimal arithmetic on bigint. A value is `coef × 10^-scale`.
 *
 * Addition, subtraction and multiplication are exact. Only `round` and `div`
 * lose information, and both demand a rounding mode, so every place a figure
 * is rounded is visible at the call site.
 */

export const ROUNDING_MODES = ["half-away-from-zero", "half-even", "half-toward-zero", "away-from-zero", "toward-zero", "floor", "ceil"] as const;

export type RoundingMode = (typeof ROUNDING_MODES)[number];

/** A decimal as a string: "12", "-0.375", "+3". The one grammar for amounts, here and in the schema. */
export const DECIMAL = /^([+-])?(\d+)(?:\.(\d+))?$/;
const pow10 = (n: number): bigint => 10n ** BigInt(n);

export class Decimal {
    readonly coef: bigint;
    readonly scale: number;

    private constructor(coef: bigint, scale: number) {
        this.coef = coef;
        this.scale = scale;
    }

    static readonly ZERO = new Decimal(0n, 0);

    /** Parses "12", "-0.375", "1300.00". Numbers are refused: a float is already wrong. */
    static from(value: string | bigint | Decimal): Decimal {
        if (value instanceof Decimal) return value;
        if (typeof value === "bigint") return new Decimal(value, 0);
        if (typeof value !== "string") throw new TypeError(`refused ${typeof value}: pass amounts as decimal strings`);
        const m = DECIMAL.exec(value.trim());
        if (!m) throw new TypeError(`not a decimal: ${JSON.stringify(value)}`);
        const [, sign, whole, fraction = ""] = m;
        const coef = BigInt(whole! + fraction);
        return new Decimal(sign === "-" ? -coef : coef, fraction.length);
    }

    static sum(values: Iterable<Decimal>): Decimal {
        let total = Decimal.ZERO;
        for (const v of values) total = total.add(v);
        return total;
    }

    private rescale(scale: number): bigint {
        return this.coef * pow10(scale - this.scale);
    }

    add(other: Decimal): Decimal {
        const scale = Math.max(this.scale, other.scale);
        return new Decimal(this.rescale(scale) + other.rescale(scale), scale);
    }

    sub(other: Decimal): Decimal {
        return this.add(other.neg());
    }

    mul(other: Decimal): Decimal {
        return new Decimal(this.coef * other.coef, this.scale + other.scale);
    }

    /** `this / divisor`, rounded to `scale` places. */
    div(divisor: Decimal, scale: number, mode: RoundingMode): Decimal {
        assertScale(scale);
        if (divisor.coef === 0n) throw new RangeError("division by zero");
        // this/divisor = (a·10^-sa)/(b·10^-sb); scaled by 10^scale it is a·10^k / b.
        const k = scale - this.scale + divisor.scale;
        const n = k >= 0 ? this.coef * pow10(k) : this.coef;
        const d = k >= 0 ? divisor.coef : divisor.coef * pow10(-k);
        return new Decimal(roundDiv(n, d, mode), scale);
    }

    round(scale: number, mode: RoundingMode): Decimal {
        assertScale(scale);
        if (scale >= this.scale) return new Decimal(this.rescale(scale), scale);
        return new Decimal(roundDiv(this.coef, pow10(this.scale - scale), mode), scale);
    }

    /** Rounds to a multiple of `increment` (cash rounding: 0.05). */
    roundTo(increment: Decimal, mode: RoundingMode): Decimal {
        if (increment.sign() <= 0) throw new RangeError(`rounding increment must be positive, got ${increment}`);
        return this.div(increment, 0, mode).mul(increment);
    }

    /** The same value without trailing fractional zeros: "25.0" → "25". */
    normalize(): Decimal {
        let { coef, scale } = this;
        while (scale > 0 && coef % 10n === 0n) {
            coef /= 10n;
            scale--;
        }
        return new Decimal(coef, scale);
    }

    neg(): Decimal {
        return new Decimal(-this.coef, this.scale);
    }

    abs(): Decimal {
        return this.coef < 0n ? this.neg() : this;
    }

    cmp(other: Decimal): -1 | 0 | 1 {
        const scale = Math.max(this.scale, other.scale);
        const a = this.rescale(scale);
        const b = other.rescale(scale);
        return a < b ? -1 : a > b ? 1 : 0;
    }

    eq(other: Decimal): boolean {
        return this.cmp(other) === 0;
    }

    isZero(): boolean {
        return this.coef === 0n;
    }

    sign(): -1 | 0 | 1 {
        return this.coef < 0n ? -1 : this.coef > 0n ? 1 : 0;
    }

    toString(): string {
        const neg = this.coef < 0n;
        const digits = (neg ? -this.coef : this.coef).toString().padStart(this.scale + 1, "0");
        const whole = digits.slice(0, digits.length - this.scale);
        const fraction = this.scale > 0 ? `.${digits.slice(-this.scale)}` : "";
        return `${neg ? "-" : ""}${whole}${fraction}`;
    }

    toJSON(): string {
        return this.toString();
    }
}

export const dec = Decimal.from;

function assertScale(scale: number): void {
    if (!Number.isSafeInteger(scale) || scale < 0) throw new RangeError(`scale must be a non-negative integer, got ${scale}`);
}

/** Integer `n / d` rounded by `mode`. */
function roundDiv(n: bigint, d: bigint, mode: RoundingMode): bigint {
    if (d < 0n) {
        n = -n;
        d = -d;
    }
    const q = n / d;
    const r = n % d;
    if (r === 0n) return q;
    const away = n < 0n ? q - 1n : q + 1n;
    const twice = 2n * (r < 0n ? -r : r);
    switch (mode) {
        case "toward-zero":
            return q;
        case "away-from-zero":
            return away;
        case "floor":
            return n < 0n ? away : q;
        case "ceil":
            return n > 0n ? away : q;
        case "half-away-from-zero":
            return twice >= d ? away : q;
        case "half-toward-zero":
            return twice > d ? away : q;
        case "half-even":
            if (twice !== d) return twice > d ? away : q;
            return q % 2n === 0n ? q : away;
    }
}
