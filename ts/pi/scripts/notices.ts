// Third-party notices for the bundle: the license of every npm package esbuild put in it.
//   node scripts/notices.ts dist/meta.json > dist/THIRD_PARTY_LICENSES.txt

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const meta = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as { inputs: Record<string, unknown> };
const packages = new Set<string>();
for (const input of Object.keys(meta.inputs)) {
  const match = input.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//g);
  const last = match?.at(-1);
  if (last) packages.add(input.slice(0, input.lastIndexOf(last) + last.length));
}
const sections = [...packages].sort().map((directory) => {
  const manifest = JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8")) as { name: string; version: string; license?: string };
  const file = readdirSync(join(root, directory)).find((name) => /^(licen[cs]e|copying|notice)/i.test(name));
  const text = file && existsSync(join(root, directory, file)) ? readFileSync(join(root, directory, file), "utf8").trim() : `License: ${manifest.license ?? "unknown"}`;
  return `${manifest.name} ${manifest.version} (${manifest.license ?? "unknown"})\n\n${text}`;
});
process.stdout.write(`Third-party software bundled in bridge.mjs\n\n${sections.join(`\n\n${"-".repeat(72)}\n\n`)}\n`);
