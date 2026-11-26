// The pi bridge's entry: serves Kedi on stdio.
//
//   node bridge.ts [--cwd DIR]     serve, pi's tools working in DIR (the current directory by default)
//   node bridge.ts --check         run the preflight and print its report
//
// The SDK comes first: from then on, whatever pi prints goes to stderr.

import { serve } from "../sdk/src/index.ts";
import { piBridge } from "./pi.ts";

const index = process.argv.indexOf("--cwd");
await serve(piBridge({ cwd: index === -1 ? process.cwd() : process.argv[index + 1]! }));
