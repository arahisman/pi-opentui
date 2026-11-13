import { test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { PiHost, replacedPresentation } from "../src/host/controller.ts";

test("legacy presentation filters do not remove business extensions", () => {
  expect(
    replacedPresentation(
      "/global/local-packages/ui-extension/extensions/index.ts",
    ),
  ).toBe(true);
  expect(
    replacedPresentation("/global/local-packages/sidebar-tui/index.ts"),
  ).toBe(true);
  expect(
    replacedPresentation(
      "/global/local-packages/experiment/extensions/opencode-background.ts",
    ),
  ).toBe(true);
  expect(
    replacedPresentation("/global/local-packages/advisor/src/index.ts"),
  ).toBe(false);
});

test("real Pi SDK streams, runs tool dialogs and persists/resumes without provider traffic", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-opentui-sdk-"));
  const agentDir = join(dir, "agent");
  let requests = 0;
  const factory = (
    pi: Parameters<
      NonNullable<
        Parameters<typeof PiHost.create>[0]["extensionFactories"]
      >[number]
    >[0],
  ) => {
    pi.registerProvider("offline-test", {
      name: "Offline fixture",
      baseUrl: "http://127.0.0.1:9",
      apiKey: "offline-fixture",
      api: "openai-completions",
      models: [
        {
          id: "fixture",
          name: "Fixture",
          reasoning: false,
          input: ["text"],
          contextWindow: 32000,
          maxTokens: 2048,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      streamSimple: (model, context, options) => {
        requests++;
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          const hasResult = context.messages.some(
            (message) => message.role === "toolResult",
          );
          const message: AssistantMessage = {
            role: "assistant",
            api: model.api,
            provider: model.provider,
            model: model.id,
            timestamp: Date.now(),
            content: hasResult
              ? [{ type: "text", text: "Saved answer and completed." }]
              : [
                  {
                    type: "toolCall",
                    id: "question-1",
                    name: "offline_question",
                    arguments: {},
                  },
                ],
            stopReason: hasResult ? "stop" : "toolUse",
            usage: {
              input: 20,
              output: 10,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 30,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
          };
          stream.push({ type: "start", partial: message });
          stream.push({
            type: "done",
            reason: message.stopReason as "stop" | "toolUse",
            message,
          });
          stream.end();
        });
        return stream;
      },
    });
    pi.registerTool({
      name: "offline_question",
      label: "Offline question",
      description: "Question for host integration",
      parameters: Type.Object({}),
      execute: async (_id, _args, _signal, _update, ctx) => {
        const answer = await ctx.ui.select("Pick a fixture", ["A", "B"]);
        return {
          content: [{ type: "text" as const, text: answer ?? "cancelled" }],
          details: {},
        };
      },
    });
  };
  let host: PiHost | undefined;
  try {
    host = await PiHost.create({
      cwd: dir,
      agentDir,
      clean: true,
      extensionFactories: [factory],
    });
    await host.selectModel("offline-test", "fixture");
    const ready = new Promise<void>((resolve) => {
      host!.on("change", () => {
        if (host!.bridge.activeDialog) {
          host!.bridge.resolveDialog("B");
          resolve();
        }
      });
    });
    const run = host.send("Run the fixture tool and finish.");
    await ready;
    await run;
    expect(requests).toBe(2);
    expect(
      host.transcript.some((row) => row.text.includes("Saved answer")),
    ).toBe(true);
    expect(
      host.transcript.some(
        (row) => row.kind === "toolResult" && row.text === "B",
      ),
    ).toBe(true);
    expect(host.snapshot().usage.totals.input).toBe(40);
    const file = host.session.sessionFile!;
    expect(readFileSync(file, "utf8")).toContain("Saved answer");
    await host.close();
    host = undefined;
    host = await PiHost.create({
      cwd: dir,
      agentDir,
      clean: true,
      sessionFile: file,
      extensionFactories: [factory],
    });
    expect(
      host.transcript.some((row) => row.text.includes("Saved answer")),
    ).toBe(true);
    expect(host.session.model?.id).toBe("fixture");
  } finally {
    await host?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);

test("native completion catalog precedes module wrappers and refreshes discovered resources without duplicating them", async () => {
  const { mkdirSync } = await import("node:fs");
  const { createHostAutocompleteProvider } =
    await import("../src/host/controller.ts");
  const directory = mkdtempSync(join(tmpdir(), "pi-completions-"));
  const agent = join(directory, "agent"),
    first = join(directory, "first"),
    second = join(directory, "second");
  const write = (file: string, content: string) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  write(
    join(agent, "skills", "common", "SKILL.md"),
    "---\nname: common\ndescription: A common skill\n---\nSkill body\n",
  );
  write(
    join(agent, "prompts", "review.md"),
    '---\ndescription: Review a topic\nargument-hint: "<topic>"\n---\nReview $1\n',
  );
  for (const [cwd, name] of [
    [first, "first-discovered"],
    [second, "second-discovered"],
  ]) {
    write(
      join(cwd!, "external-skills", name!, "SKILL.md"),
      `---\nname: ${name}\ndescription: A dynamically discovered skill\n---\nBody\n`,
    );
    write(join(cwd!, "src", "needle.ts"), "local file\n");
    write(join(cwd!, ".gitignore"), "ignored.txt\n");
    write(join(cwd!, "ignored.txt"), "hidden\n");
  }
  write(
    join(second, "resume.jsonl"),
    JSON.stringify({
      type: "session",
      version: 3,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      cwd: second,
    }) + "\n",
  );
  let factoryCalls = 0,
    suggestionCalls = 0;
  const startupOptions: string[][] = [];
  let host: PiHost | undefined;
  try {
    host = await PiHost.create({
      cwd: first,
      agentDir: agent,
      clean: true,
      extensionFactories: [
        (pi) => {
          pi.registerProvider("offline-completion", {
            name: "Offline completion fixture",
            baseUrl: "http://127.0.0.1:9",
            apiKey: "offline-fixture",
            api: "openai-completions",
            models: [
              {
                id: "model-one",
                name: "Model one",
                reasoning: false,
                input: ["text"],
                contextWindow: 32000,
                maxTokens: 2048,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          });
          pi.registerCommand("smoke-config", {
            description: "Fixture choices",
            getArgumentCompletions: async (prefix) =>
              [{ value: "safe", label: "Safe choice" }].filter((item) =>
                item.value.startsWith(prefix),
              ),
            handler: async () => {},
          });
          pi.on("resources_discover", (_event, ctx) => ({
            skillPaths: [join(ctx.cwd, "external-skills")],
          }));
          pi.on("session_start", async (_event, ctx) => {
            ctx.ui.addAutocompleteProvider((current) => {
              factoryCalls++;
              return {
                triggerCharacters: ["!"],
                applyCompletion: current.applyCompletion.bind(current),
                getSuggestions: async (...args) => {
                  suggestionCalls++;
                  return current.getSuggestions(...args);
                },
              };
            });
            let provider:
              | import("@earendil-works/pi-tui").AutocompleteProvider
              | undefined;
            ctx.ui.addAutocompleteProvider((current) => {
              provider = current;
              return current;
            });
            const line = "/smoke-config s";
            startupOptions.push(
              (
                await provider!.getSuggestions([line], 0, line.length, {
                  signal: new AbortController().signal,
                })
              )?.items.map((item) => item.value) ?? [],
            );
            const base = ctx.ui.getEditorComponent()!;
            ctx.ui.setEditorComponent((tui, theme, keys) => {
              const editor = base(tui, theme, keys),
                render = editor.render.bind(editor);
              editor.render = (width) => [
                "module editor addon",
                ...render(width),
              ];
              return editor;
            });
          });
        },
      ],
    });
    const request = async (line: string) => {
      let provider:
        | import("@earendil-works/pi-tui").AutocompleteProvider
        | undefined;
      host!.bridge.addAutocompleteProvider((current) => {
        provider = current;
        return current;
      });
      const before = suggestionCalls;
      const result = await provider!.getSuggestions([line], 0, line.length, {
        signal: new AbortController().signal,
      });
      expect(suggestionCalls - before).toBe(1);
      return result;
    };
    const catalog = host.completionCommands();
    expect(
      catalog.find((command) => command.name === "smoke-config")
        ?.getArgumentCompletions,
    ).toBeDefined();
    expect(
      catalog.find((command) => command.name === "review")?.argumentHint,
    ).toBe("<topic>");
    expect(
      catalog.find((command) => command.name === "skill:common")?.source,
    ).toBe("skill");
    expect(
      catalog.find((command) => command.name === "skill:first-discovered")
        ?.source,
    ).toBe("skill");
    expect(catalog.find((command) => command.name === "export")?.source).toBe(
      "builtin",
    );
    expect((await request("/smoke-config s"))?.items[0]?.value).toBe("safe");
    expect(
      (await request("/review"))?.items.some((item) => item.value === "review"),
    ).toBe(true);
    expect(
      (await request("/skill:common"))?.items.some(
        (item) => item.value === "skill:common",
      ),
    ).toBe(true);
    expect((await request("/model off"))?.items[0]?.value).toBe(
      "offline-completion/model-one",
    );
    expect(
      (await request("@needle"))?.items.some(
        (item) => item.value === "@src/needle.ts",
      ),
    ).toBe(true);
    expect(
      (await request("./src/nee"))?.items.some(
        (item) => item.label === "needle.ts",
      ),
    ).toBe(true);
    expect(
      host.commands().find((command) => command.name === "smoke-config")
        ?.getArgumentCompletions,
    ).toBeDefined();
    const beforeFactories = factoryCalls;
    for (let index = 0; index < 20; index++)
      expect(host.completionCommands()).toBe(catalog);
    expect(factoryCalls).toBe(beforeFactories);
    expect(
      host.bridge
        .renderEditor(80)
        .filter((line) => line === "module editor addon"),
    ).toHaveLength(1);
    await host.reload();
    expect((await request("/smoke-config s"))?.items[0]?.value).toBe("safe");
    expect(
      host.bridge
        .renderEditor(80)
        .filter((line) => line === "module editor addon"),
    ).toHaveLength(1);
    await host.switchSession(join(second, "resume.jsonl"));
    expect(
      host
        .completionCommands()
        .some((command) => command.name === "skill:first-discovered"),
    ).toBe(false);
    expect(
      host
        .completionCommands()
        .some((command) => command.name === "skill:second-discovered"),
    ).toBe(true);
    expect(
      (await request("@needle"))?.items.some(
        (item) => item.value === "@src/needle.ts",
      ),
    ).toBe(true);
    expect(
      host.bridge
        .renderEditor(80)
        .filter((line) => line === "module editor addon"),
    ).toHaveLength(1);
    expect(startupOptions).toEqual([["safe"], ["safe"], ["safe"]]);
    expect(host.diagnostics).toEqual([]);
    const fallback = createHostAutocompleteProvider([], first, null);
    const fallbackLine = "@needle";
    expect(
      (
        await fallback.getSuggestions([fallbackLine], 0, fallbackLine.length, {
          signal: new AbortController().signal,
        })
      )?.items.some((item) => item.value === "@src/needle.ts"),
    ).toBe(true);
  } finally {
    await host?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 20000);

test("fd-less local file completion respects project ignores, quoted paths, missing directories and abort", async () => {
  const { mkdirSync } = await import("node:fs");
  const { createHostAutocompleteProvider } =
    await import("../src/host/controller.ts");
  const directory = mkdtempSync(join(tmpdir(), "pi-file-completion-"));
  try {
    mkdirSync(join(directory, "src"));
    writeFileSync(join(directory, "src", "file name.ts"), "body");
    writeFileSync(join(directory, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(directory, "ignored.txt"), "hidden");
    const provider = createHostAutocompleteProvider([], directory, null);
    const get = (line: string, signal = new AbortController().signal) =>
      provider.getSuggestions([line], 0, line.length, { signal });
    expect((await get('@"src/file n'))?.items[0]?.value).toBe(
      '@"src/file name.ts"',
    );
    expect(await get("@ignored")).toBeNull();
    writeFileSync(join(directory, "src", "ignored.txt"), "scoped ignore");
    writeFileSync(
      join(directory, ".gitignore"),
      "ignored.txt\nsrc/ignored.txt\n",
    );
    expect(await get("@src/ignored")).toBeNull();
    writeFileSync(join(directory, "src", ".gitignore"), "!ignored.txt\n");
    expect((await get("@src/ignored"))?.items[0]?.value).toBe(
      "@src/ignored.txt",
    );
    expect(await get("@missing/file")).toBeNull();
    const abort = new AbortController();
    abort.abort();
    expect(await get("@file", abort.signal)).toBeNull();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("initial explicit session resume uses its saved project rather than the launch directory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-initial-resume-"));
  const firstProject = join(directory, "first"),
    savedProject = join(directory, "saved"),
    agentDir = join(directory, "agent");
  mkdirSync(firstProject);
  mkdirSync(savedProject);
  let host = await PiHost.create({ cwd: savedProject, agentDir, clean: true });
  try {
    host.session.sessionManager.appendMessage({
      role: "user",
      content: "Saved project session",
      timestamp: Date.now(),
    });
    const sessionFile = host.session.sessionFile!;
    await host.close();
    host = await PiHost.create({
      cwd: firstProject,
      agentDir,
      clean: true,
      sessionFile,
    });
    expect(host.session.sessionManager.getCwd()).toBe(savedProject);
    expect(host.runtime.cwd).toBe(savedProject);
  } finally {
    await host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
