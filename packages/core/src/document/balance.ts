import { Decimal, dec } from "../money/decimal.ts";
import { daysBetween } from "./dates.ts";
import type { IssuedState } from "./types.ts";

export interface Balance {
    payable: string;
    /** Payments, credits and write-offs, less any reversed. */
    settled: string;
    outstanding: string;
    status: "open" | "partial" | "settled";
    dueDate: string;
    overdue: boolean;
    /** 0 when not overdue. */
    daysOverdue: number;
}

/**
 * Where an issued document stands at the end of `asOf`, counting the
 * settlements dated on or before it; without `asOf`, every settlement. Derived
 * each time, never stored, so it cannot drift from the settlements.
 */
export function balance(doc: IssuedState, asOf?: string): Balance {
    const { scale } = doc.figures;
    const payable = dec(doc.figures.totals.payable);
    const counted = doc.settlements.filter((s) => !s.reversed && (asOf === undefined || s.date <= asOf));
    const settled = Decimal.sum(counted.map((s) => dec(s.amount)));
    const outstanding = Decimal.ZERO.round(scale, "toward-zero").add(payable.sub(settled));
    const late = asOf === undefined ? 0 : daysBetween(doc.dueDate, asOf);
    const open = outstanding.sign() > 0;
    return {
        payable: payable.toString(),
        settled: settled.round(scale, "toward-zero").toString(),
        outstanding: outstanding.toString(),
        status: !open ? "settled" : settled.isZero() ? "open" : "partial",
        dueDate: doc.dueDate,
        overdue: open && late > 0,
        daysOverdue: open && late > 0 ? late : 0,
    };
}
