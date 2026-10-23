// Times compute on synthetic invoices of growing size. Usage: node scripts/bench.ts
import { compute } from "../src/index.ts";
import type { InvoiceInput, Policy } from "../src/model.ts";

const POLICY: Policy = { id: "b", taxRounding: "document", rounding: { amounts: "half-away-from-zero", tax: "half-away-from-zero" }, pricesIncludeTax: false };

const rates = ["6", "8", "10", "25"];
const make = (n: number): InvoiceInput => ({
    currency: "MYR",
    lines: Array.from({ length: n }, (_, i) => ({
        id: String(i),
        quantity: String((i % 7) + 1) + ".5",
        price: `${(i * 37) % 9999}.${String(i % 100).padStart(2, "0")}`,
        allowances: i % 3 ? [] : [{ percent: "5", base: "100.00" }],
        taxes: [{ category: "S", rate: rates[i % 4]! }],
    })),
    allowances: [{ amount: "100.00", taxes: [{ category: "S", rate: "8" }] }],
});

for (const n of [10, 100, 1_000, 10_000]) {
    const input = make(n);
    for (let i = 0; i < 20; i++) compute(input, POLICY);
    const runs = n >= 10_000 ? 30 : 300;
    const times: number[] = [];
    for (let i = 0; i < runs; i++) {
        const t = performance.now();
        compute(input, POLICY);
        times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    console.log(`${String(n).padStart(6)} lines  median ${times[runs >> 1]!.toFixed(3)} ms  p95 ${times[Math.floor(runs * 0.95)]!.toFixed(3)} ms`);
}
