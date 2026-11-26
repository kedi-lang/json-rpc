// A bridge whose harness prints to stdout, at import and while it runs.
import { serve } from "../../src/index.ts";
import { minimal } from "./minimal.ts";

console.log("harness banner on stdout");
process.stdout.write("raw stdout write\n");
const bridge = minimal({ testModel: true });
const run = bridge.run.bind(bridge);
bridge.run = async (current) => {
  console.log("harness log during a run");
  return run(current);
};
await serve(bridge);
