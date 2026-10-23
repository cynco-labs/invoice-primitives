// Downloads the official EN 16931 and Peppol BIS 3 example invoices into corpus/.
// They are fetched, not vendored: the CEN files are EUPL-1.2 and the Peppol
// repository declares no license.
import { mkdirSync, writeFileSync } from "node:fs";

const SOURCES = [
    { repo: "ConnectingEurope/eInvoicing-EN16931", dir: "ubl/examples", ref: "master", prefix: "cen" },
    { repo: "OpenPEPPOL/peppol-bis-invoice-3", dir: "rules/examples", ref: "master", prefix: "peppol" },
];

const out = new URL("../corpus/", import.meta.url);
mkdirSync(out, { recursive: true });
let count = 0;
for (const { repo, dir, ref, prefix } of SOURCES) {
    const listing = await (
        await fetch(`https://api.github.com/repos/${repo}/contents/${dir}?ref=${ref}`)
    ).json();
    for (const file of listing) {
        if (!/\.xml$/i.test(file.name)) continue;
        const body = await (await fetch(file.download_url)).text();
        writeFileSync(new URL(`${prefix}--${file.name}`, out), body);
        count++;
    }
}
console.log(`fetched ${count} files into corpus/`);
