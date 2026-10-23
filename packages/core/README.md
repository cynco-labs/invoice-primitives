# @invoice-primitives/core

Exact, versioned invoicing primitives: calculation, documents, numbering, payments, credit notes, presentation and an in-memory backend. No dependencies.

```ts
import { createMemoryBooks } from "@invoice-primitives/core";

const books = createMemoryBooks();
await books.configure({ country: "MY", seller: { name: "Kedai Kopi Sdn Bhd" } });
const draft = await books.create({ buyer: { name: "Acme" }, lines: [{ name: "Consulting", quantity: "10", price: "150.00", tax: "service-8" }] });
await books.issue(draft.id);
```

The full guide, backends and design are in the repository's root README and DESIGN.md.
