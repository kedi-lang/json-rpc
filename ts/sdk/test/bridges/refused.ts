// A bridge whose handshake breaks a dependency rule: serve() refuses it at initialize.
import { serve } from "../../src/index.ts";
import { minimal } from "./minimal.ts";

await serve(minimal({ governed: true, liveInput: true, testModel: true }));
