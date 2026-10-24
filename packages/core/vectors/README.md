# Test vectors

Inputs and the outputs `@invoice-primitives/core` gives for them, as JSON, for
an implementation in another language to check itself against. `pnpm gen`
writes them; a test replays them from these files and fails if they drift.

- `calculation.json`: `{ name, policy, input, output | refused }`. Run
  `compute(input, policy)`. `output` is the line nets as `[id, net]`, the tax
  subtotals and the totals, every amount a decimal string. `refused` is the
  `{ code, path }` of the refusal.
- `documents.json`: `{ name, now, timeZone, steps: [{ command, events | refused }] }`.
  Run each command on the state the previous one left, with the bundled packs,
  `now` as the clock and `timeZone` as the seller's zone. `events` are the
  events it produces (none for a repeat); `refused` is the refusal.

The shapes are in `../schema/invoice-primitives.schema.json`.
