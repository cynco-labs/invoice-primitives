import { Decimal } from "./decimal.ts";

/**
 * Splits `total` across `weights` in proportion, in whole units of `scale`
 * places, so the parts sum to `total` exactly (largest remainder). Ties go to
 * the earlier weight. Weights may be negative, as on a correction line.
 */
export function allocate(total: Decimal, weights: readonly Decimal[], scale: number): Decimal[] {
    if (!total.round(scale, "toward-zero").eq(total)) {
        throw new RangeError(`cannot allocate ${total} in whole units of ${scale} decimals`);
    }
    const sum = Decimal.sum(weights);
    if (sum.isZero()) {
        if (total.isZero()) return weights.map(() => Decimal.ZERO.round(scale, "toward-zero"));
        throw new RangeError("cannot allocate a non-zero total across weights that sum to zero");
    }
    const exact = weights.map((w) => total.mul(w).div(sum, scale + 12, "half-even"));
    const parts = exact.map((e) => e.round(scale, "toward-zero"));
    const residual = total.sub(Decimal.sum(parts)).round(scale, "half-even").coef;
    if (residual === 0n) return parts;

    const up = residual > 0n;
    const step = Decimal.from(up ? "1" : "-1").div(Decimal.from(10n ** BigInt(scale)), scale, "toward-zero");
    const order = exact
        .map((e, index) => ({ index, remainder: e.sub(parts[index]!) }))
        .sort((a, b) => (up ? b.remainder.cmp(a.remainder) : a.remainder.cmp(b.remainder)) || a.index - b.index);
    const count = Number(up ? residual : -residual);
    for (let k = 0; k < count; k++) {
        const { index } = order[k % order.length]!;
        parts[index] = parts[index]!.add(step);
    }
    return parts;
}
