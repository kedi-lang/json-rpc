// Small bridges for the SDK's tests: each answers with its model's text.

import type { Bridge, Capabilities, ModelRequest, Run, TranscriptMessage } from "../../src/index.ts";

/** A request in Kedi's schema, answered by the test model. */
export function request(run: Run, messages: TranscriptMessage[]): ModelRequest<TranscriptMessage> {
  return {
    describe: () => ({ system: run.params.system, messages, tools: [], output: null }),
    send: async () => ({ role: "assistant", parts: [{ type: "text", text: "real model" }] }),
    reply: (message) => message,
  };
}

export function textOf(message: TranscriptMessage): string {
  return message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** A bridge that converses through the SDK: model requests, Kedi's tools, continuations. */
export function minimal(capabilities: Capabilities, options: { onInput?: boolean } = {}): Bridge {
  return {
    handshake: { backend: { name: "minimal" }, kind: "agent-framework", capabilities },
    async run(run) {
      const say = (role: "user" | "assistant", text: string): TranscriptMessage => ({ role, parts: [{ type: "text", text }] });
      const messages: TranscriptMessage[] = [say("user", run.params.user)];
      const continuation = run.params.continuation;
      if (continuation) messages.push(say("assistant", String(continuation.answer.text)), say("user", continuation.message));
      if (options.onInput) run.onInput((texts) => texts.forEach((text) => messages.push(say("user", text))));
      for (;;) {
        const reply = await run.modelRequest(request(run, messages));
        messages.push(reply);
        const calls = reply.parts.filter((part) => part.type === "toolCall");
        if (!calls.length) return { text: textOf(reply) };
        for (const call of calls) {
          const outcome = await run.callTool(call.id, call.name, call.arguments as never);
          messages.push({ role: "tool", parts: [{ type: "toolResult", id: call.id, result: outcome.ok ? outcome.result : outcome.error }] });
        }
      }
    },
  };
}

/** A bridge that calls its model itself, around the SDK: nothing is admitted or scripted. */
export function bypassing(capabilities: Capabilities): Bridge {
  return {
    handshake: { backend: { name: "bypassing" }, kind: "agent-framework", capabilities },
    async run() {
      return { text: "real model" };
    },
  };
}
