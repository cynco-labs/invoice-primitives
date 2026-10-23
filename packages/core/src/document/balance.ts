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
 * Where an issued document stands on a calendar date. Derived from its
 * settlements every time, never stored, so it cannot drift from them.
 */
export function balance(doc: IssuedState, asOf: string): Balance {
    const { scale } = doc.figures;
    const payable = dec(doc.figures.totals.payable);
    const settled = Decimal.sum(doc.settlements.filter((s) => !s.reversed).map((s) => dec(s.amount)));
    const outstanding = Decimal.ZERO.round(scale, "toward-zero").add(payable.sub(settled));
    const late = daysBetween(doc.dueDate, asOf);
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
