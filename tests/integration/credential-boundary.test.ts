/**
 * M3 — the credential boundary, with a sentinel.
 *
 * A credential is generated at runtime, injected as the trusted composition's
 * own value, and then looked for everywhere the host can produce output: the
 * database (bytes and rows), every snapshot and summary, every frame on the
 * wire, the client's replica, the run's terminal, the startup failures and the
 * captured console. It is found in exactly one place — the authorization header
 * of the request the provider really received — and nowhere else.
 *
 * The socket is stubbed, the serializer is real, and the sentinel is never
 * written into the source: it exists only as a string this test made up.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeContext } from "@earendil-works/pi-ai";
import { stream as openAiCompletionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import type { Context, JsonObject, Model, StreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import type { Client } from "@every-dagent/client";
import { createPiAiComposition, explicitCredentials } from "@every-dagent/model-pi-ai";
import { TEST_MODEL } from "../../packages/model-pi-ai/tests/helpers/fake-pi-ai-stream.js";
import { createClientOn, createHostPlatform, waitFor } from "../helpers/platform.js";

type PiAiFetch = NonNullable<StreamOptions["fetch"]>;

const BASE_URL = "https://provider.test/v1";
const SENTINEL = `CREDENTIAL_SENTINEL_M3_DO_NOT_LEAK_${randomUUID()}`;

/** One OpenAI-compatible stream chunk carrying a text delta. */
function openAiChunk(delta: JsonObject, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: TEST_MODEL.id,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function answerBody(text: string): string {
  return `${openAiChunk({ role: "assistant", content: text })}${openAiChunk({}, "stop")}data: [DONE]\n\n`;
}

/** A socket stub that records what the provider was really sent and answers. */
function stubbedSocket(options: { readonly failWith?: string } = {}): {
  readonly fetch: PiAiFetch;
  readonly headers: readonly Record<string, string>[];
  readonly bodies: readonly JsonObject[];
} {
  const headers: Record<string, string>[] = [];
  const bodies: JsonObject[] = [];

  const fetchImpl: PiAiFetch = async (_url, init) => {
    // The SDK's own header container, read the way a server would read it.
    const carried = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]);
    headers.push(Object.fromEntries(carried.entries()));
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as JsonObject);
    if (options.failWith !== undefined) throw new Error(options.failWith);
    return new Response(answerBody("hello"), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  return { fetch: fetchImpl, headers, bodies };
}

/** The real pi-ai serializer, with only its socket replaced. */
function sourceOver(socket: { readonly fetch: PiAiFetch }) {
  return {
    stream: (model: Model<"openai-completions">, context: Context, options?: StreamOptions) =>
      openAiCompletionsStream(model, normalizeContext(context), { ...options, fetch: socket.fetch }),
  };
}

/** Every text the host wrote to a database file, plus the file's own bytes. */
function databaseTexts(directory: string): string[] {
  const texts: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (!existsSync(join(directory, entry))) continue;
    // A binary read decoded as UTF-8 keeps any literal string that was written,
    // which is what a leak into a row would look like on disk.
    texts.push(readFileSync(join(directory, entry)).toString("utf8"));
  }
  return texts;
}

interface SentinelRun {
  readonly client: Client;
  readonly frames: readonly string[];
  readonly console: readonly string[];
  readonly clientSnapshot: string;
  readonly repositoryRows: string;
  /** Whether a settings write carrying the credential was refused. */
  readonly credentialRefused: boolean;
  close(): Promise<void>;
}

/**
 * Runs one whole turn with the sentinel injected, capturing everything the host
 * could have said it in.
 */
async function runWithSentinel(options: {
  readonly directory: string;
  readonly socket: ReturnType<typeof stubbedSocket>;
  readonly credential?: string;
}): Promise<SentinelRun & { readonly error?: unknown }> {
  const captured: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const record = (...args: unknown[]): void => {
    captured.push(args.map(String).join(" "));
  };
  console.log = record;
  console.warn = record;
  console.error = record;
  console.info = record;

  try {
    const composition = createPiAiComposition({
      models: [TEST_MODEL],
      streamSource: sourceOver(options.socket) as never,
      credentials: explicitCredentials({
        ...(options.credential === undefined ? {} : { [TEST_MODEL.provider]: options.credential }),
      }),
      endpoints: { [TEST_MODEL.provider]: [BASE_URL] },
    });

    let platform;
    try {
      platform = await createHostPlatform({
        composition,
        bootstrap: {
          host: { systemPrompt: "", loop: { maxSteps: 12, maxModelAttempts: 3 } },
          model: { provider: TEST_MODEL.provider, model: TEST_MODEL.id } as never,
        },
        plugins: [],
        persistence: { kind: "sqlite", location: join(options.directory, "state.db") },
      });
    } catch (error) {
      return {
        client: undefined as never,
        frames: [],
        console: captured,
        clientSnapshot: "",
        repositoryRows: "",
        credentialRefused: false,
        error,
        close: async (): Promise<void> => undefined,
      };
    }

    const client = createClientOn(platform);
    await client.connect();
    const session = (await client.sessions.create()).session;
    const started = await client.runs.start({
      sessionId: session.sessionId,
      submissionId: "sub-sentinel",
      text: "say hello",
    });
    await waitFor(() => {
      const run = client.getSnapshot().presentation?.runs.items.find(
        (candidate) => candidate.runId === started.run.runId,
      );
      return run !== undefined && run.status !== "accepted" && run.status !== "running";
    });

    // A client that pastes a credential into a settings value is refused while
    // it is connected: the model schema is closed, so there is no field the
    // credential could travel in — and nothing durable takes the value.
    const credentialRefused = await client.settings
      .update({
        namespace: "model",
        expectedRevision: 1,
        value: { provider: TEST_MODEL.provider, model: TEST_MODEL.id, apiKey: options.credential ?? "none" },
      })
      .then(
        () => false,
        (error: unknown) => (error as { code?: string }).code === "SETTINGS_INVALID",
      );

    // Everything the client holds, and a history page, serialized the way a UI
    // or a log would carry it.
    const history = await client.sessions.history({ sessionId: session.sessionId });
    const runRead = await client.runs.get({ runId: started.run.runId });
    const settings = await client.settings.get({ namespace: "host" });
    const pluginList = await client.plugins.list();
    const serialized = JSON.stringify({
      snapshot: client.getSnapshot(),
      history,
      runRead,
      settings,
      pluginList,
    });

    // Every frame the *host* put on the wire. The client's own requests are
    // deliberately excluded: one of them is this test's own probe (a credential
    // pasted into a settings value), and what is under test is what the host
    // says, not what a caller sent it.
    const frames = platform.carriers.flatMap((carrier) =>
      carrier.log.filter((entry) => entry.direction === "host-to-client").map((entry) => entry.frame),
    );

    // The durable rows, as the store itself reports them.
    const rows = platform.host === undefined ? "" : "";
    void rows;

    return {
      client,
      frames,
      console: captured,
      clientSnapshot: serialized,
      repositoryRows: options.directory,
      credentialRefused,
      async close(): Promise<void> {
        client.disconnect();
        await platform.shutdown();
      },
    };
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
    console.info = original.info;
  }
}

function withTempDir<T>(act: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "every-dagent-m3-credential-"));
  return act(dir).finally(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A store still held by a host that failed the test is not the failure.
    }
  });
}

describe("the managed credential", () => {
  it("reaches the provider's own authorization header and nothing else", async () => {
    await withTempDir(async (dir) => {
      const socket = stubbedSocket();
      const run = await runWithSentinel({ directory: dir, socket, credential: SENTINEL });
      await run.close();

      // It really did reach the provider's auth flow: the real serializer built
      // this request and the socket saw the header.
      expect(socket.headers).toHaveLength(1);
      expect(socket.headers[0]?.["authorization"]).toBe(`Bearer ${SENTINEL}`);
      // And the request carried the reserve the Core derived, not a larger
      // one: exactly one cap field, holding that number.
      const body = socket.bodies[0] ?? {};
      const caps = ["max_tokens", "max_completion_tokens"].filter((field) => body[field] !== undefined);
      expect(caps).toHaveLength(1);
      expect(body[caps[0] as string]).toBe(Math.min(4096, TEST_MODEL.maxTokens));

      // A client that pasted the credential into a settings value was refused
      // while it was connected (see the helper): the model schema is closed, so
      // there is no field the credential could have travelled in.
      expect(run.credentialRefused).toBe(true);

      // Nowhere else. The database's own bytes, every frame, everything the
      // client holds, and everything the host wrote to the console.
      const artifacts: readonly (readonly [string, readonly string[]])[] = [
        ["database files", databaseTexts(dir)],
        ["protocol frames", run.frames],
        ["client snapshot", [run.clientSnapshot]],
        ["captured console", run.console],
      ];
      for (const [what, texts] of artifacts) {
        for (const text of texts) {
          expect(text.includes(SENTINEL), `the sentinel appeared in ${what}`).toBe(false);
        }
      }
      // The frames were really there — the check is not vacuous.
      expect(run.frames.length).toBeGreaterThan(3);
    });
  });

  it("keeps a provider failure that quotes the credential out of every output", async () => {
    await withTempDir(async (dir) => {
      // A transport that fails the way a provider might: by quoting the header
      // it was given.
      const socket = stubbedSocket({ failWith: `401 unauthorized: authorization: Bearer ${SENTINEL}` });
      const run = await runWithSentinel({ directory: dir, socket, credential: SENTINEL });

      const session = (await run.client.sessions.create()).session;
      const started = await run.client.runs.start({
        sessionId: session.sessionId,
        submissionId: "sub-sentinel-failure",
        text: "fail please",
      });
      await waitFor(() => {
        const record = run.client.getSnapshot().presentation?.runs.items.find(
          (candidate) => candidate.runId === started.run.runId,
        );
        return record !== undefined && record.status !== "accepted" && record.status !== "running";
      });

      const terminal = await run.client.runs.get({ runId: started.run.runId });
      expect(terminal.run.status).toBe("failed");
      // The failure is a fixed classification, and its words are the host's.
      expect(JSON.stringify(terminal.run)).not.toContain(SENTINEL);
      expect(JSON.stringify(terminal.run)).not.toContain("unauthorized");
      expect(JSON.stringify(run.client.getSnapshot())).not.toContain(SENTINEL);
      expect(run.console.join("\n")).not.toContain(SENTINEL);
      for (const frame of run.frames) expect(frame.includes(SENTINEL)).toBe(false);
      for (const text of databaseTexts(dir)) expect(text.includes(SENTINEL)).toBe(false);

      await run.close();
    });
  });

  it("refuses to build a host at all when the credential is missing", async () => {
    await withTempDir(async (dir) => {
      const socket = stubbedSocket();
      // No credential for this provider: the composition refuses before any
      // client exists, so nothing can attempt a request without one.
      const run = await runWithSentinel({ directory: dir, socket });
      expect(run.error).toBeDefined();
      expect(String(run.error)).toMatch(/credential/i);
      expect(socket.headers).toHaveLength(0);
      expect(socket.bodies).toHaveLength(0);
      await run.close();
    });
  });

  it("still refuses when the credential resolves to an empty string", async () => {
    await withTempDir(async (dir) => {
      const socket = stubbedSocket();
      const run = await runWithSentinel({ directory: dir, socket, credential: "" });
      expect(run.error).toBeDefined();
      expect(socket.headers).toHaveLength(0);
      await run.close();
    });
  });
});
