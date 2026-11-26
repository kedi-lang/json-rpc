// Embeds fixtures/v1 in the SDK, so a published or bundled bridge carries its own checks.
//   node scripts/generate-fixtures.ts          write src/fixtures.generated.ts
//   node scripts/generate-fixtures.ts --check  fail if it is out of date

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "..", "..", "fixtures", "v1");
const target = join(here, "..", "src", "fixtures.generated.ts");
const fixtures = readdirSync(source)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => JSON.parse(readFileSync(join(source, name), "utf8")));
const text = `// Generated from fixtures/v1 by scripts/generate-fixtures.ts; do not edit.\n\nexport const FIXTURES = ${JSON.stringify(fixtures, null, 2)} as const;\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== text) {
    console.error("src/fixtures.generated.ts is out of date: run node scripts/generate-fixtures.ts");
    process.exit(1);
  }
} else {
  writeFileSync(target, text);
}
