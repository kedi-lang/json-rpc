// The pi bridge carries Kedi's text, media, settings and events as Kedi gave them.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { type JsonObject, RpcError } from "../../sdk/src/peer.ts";
import { streamSettings } from "../pi.ts";
import { exchange, readsTheNote } from "./harness.ts";

const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const done = () => ({ parts: [{ type: "text", text: "done" }] });

function firstTurn(seen: JsonObject[]): JsonObject[] {
  const messages = seen[0]!.messages as JsonObject[];
  return messages[0]!.parts as JsonObject[];
}

test("the user turn keeps its images where Kedi put them", async () => {
  const { seen } = await exchange({
    model: done,
    run: {
      user: "Look at photo please.",
      userContent: [
        { type: "text", text: "Look at " },
        { type: "media", name: "photo", kind: "image", mediaType: "image/png", data: PIXEL },
        { type: "text", text: " please." },
      ],
    },
  });
  assert.deepEqual(
    firstTurn(seen).map((part) => part.type === "text" ? part.text : `${part.kind}:${part.mediaType}`),
    ["Look at ", "image:image/png", " please."],
  );
});

test("an image by URL is fetched for pi, which takes base64", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "image/png" });
    response.end(Buffer.from(PIXEL, "base64"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    const { seen } = await exchange({
      model: done,
      run: { userContent: [{ type: "media", name: "photo", kind: "image", mediaType: null, url: `http://127.0.0.1:${port}/cat.png` }] },
    });
    const [image] = firstTurn(seen);
    assert.equal(image!.data, PIXEL);
    assert.equal(image!.mediaType, "image/png");
  } finally {
    server.close();
  }
});

test("Kedi's text is sent as written, never run as a pi command or template", async () => {
  const { seen, result } = await exchange({ model: done, run: { user: "/compact now, please" } });
  assert.equal(firstTurn(seen)[0]!.text, "/compact now, please");
  assert.equal(result?.text, "done");
});

test("text beside a tool call is commentary; the answer is final", async () => {
  const { events } = await exchange({
    model: (seen): JsonObject =>
      seen.length === 1
        ? { parts: [{ type: "text", text: "Let me read it." }, { type: "toolCall", id: "t1", name: "read", arguments: { path: "note.txt" } }] }
        : readsTheNote(seen),
  });
  assert.deepEqual(
    events.map((event) => [event.type, event.phase, event.text]),
    [
      ["message.completed", "commentary", "Let me read it."],
      ["message.completed", "final", "saw: The secret word is kedi.\\n"],
    ],
  );
});

test("temperature and max_tokens reach pi's request options; nothing else does", () => {
  assert.deepEqual(streamSettings({ temperature: 0.2, max_tokens: 64, top_p: 0.9 }), { temperature: 0.2, maxTokens: 64 });
  assert.deepEqual(streamSettings(undefined), {});
});

test("a failed request is tried on each fallback model, each admitted", async () => {
  const { steps, result } = await exchange({
    model: (seen) => {
      if (seen.at(-1)!.model === "primary") throw new RpcError(-32002, "primary is down");
      return done();
    },
    run: { model: "primary", fallbackModels: ["backup"] },
  });
  assert.deepEqual(steps, ["admit request", "model primary", "admit request", "model backup"]);
  assert.equal(result?.text, "done");
});
