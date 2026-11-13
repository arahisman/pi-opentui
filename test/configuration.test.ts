import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { parse } from "yaml";
import { ConfigurationDraft } from "../src/core/configuration.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-preferences-"));
  const agentDir = join(root, "agent"),
    cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const put = (path: string, value: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
  };
  const settings = join(agentDir, "settings.json");
  const projectSettings = join(cwd, ".pi", "settings.json");
  const watchdog = join(cwd, "WATCHDOG.yml");
  put(
    settings,
    JSON.stringify({
      defaultProvider: "keep-provider",
      defaultModel: "keep-model",
      unknown: { nested: true },
      subagents: {
        agentOverrides: {
          worker: {
            model: "provider/old",
            thinking: "high",
            systemPrompt: "retain me",
            inheritSkills: false,
          },
        },
        arbitrary: 42,
      },
    }),
  );
  put(
    projectSettings,
    JSON.stringify({
      unrelated: "keep",
      subagents: {
        agentOverrides: {
          worker: { inheritGlobalContext: false, instructions: "exact prompt" },
        },
      },
    }),
  );
  put(
    join(agentDir, "compaction-policy.json"),
    JSON.stringify({
      provider: "keep-provider",
      model: "old",
      thinkingLevel: "medium",
      unknown: "retain",
    }),
  );
  put(
    join(agentDir, "extensions", "subagent", "config.json"),
    JSON.stringify({
      globalConcurrencyLimit: 3,
      authorityPolicy: { custom: "retain" },
    }),
  );
  put(
    watchdog,
    "# Keep my header\nmain: false\ninstructions: shared prompt\nunknown: retained\nadvisors:\n  - name: Muse\n    model: deepseek/original\n    enabled: false\n    instructions: personal prompt\n    tools: [read]\n    future: preserve\n",
  );
  const subagents = join(agentDir, "local-packages", "subagents");
  put(
    join(subagents, "src", "agents", "agents.js"),
    `import {readFileSync} from "node:fs"; export function discoverAgentSnapshot() { const result = ${JSON.stringify({ effective: { agents: [{ name: "worker", model: "provider/old", thinking: "high" }] }, all: { userSettingsPath: settings, projectSettingsPath: projectSettings } })}; const overrides=JSON.parse(readFileSync(${JSON.stringify(projectSettings)},"utf8")).subagents?.agentOverrides?.worker; Object.assign(result.effective.agents[0],overrides); return result; }`,
  );
  put(
    join(subagents, "src", "shared", "settings-file-lease.js"),
    "export function withSettingsFileLease(path, action) { return action(); }",
  );
  put(
    join(
      agentDir,
      "local-packages",
      "advisor",
      "src",
      "advisor",
      "watchdog-config.ts",
    ),
    `export async function collectConfigCandidates() { return [{path: ${JSON.stringify(watchdog)}}]; }`,
  );
  return {
    root,
    agentDir,
    cwd,
    settings,
    projectSettings,
    watchdog,
    put,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("staged edits and discarded draft never change disk", async () => {
  const f = fixture();
  try {
    const before = readFileSync(f.projectSettings, "utf8"),
      advisor = readFileSync(f.watchdog, "utf8");
    const draft = await ConfigurationDraft.open(f);
    expect(draft.subagentsAvailable).toBe(true);
    expect(draft.advisorAvailable).toBe(true);
    draft.setRole("worker", { model: "provider/new", thinking: "low" });
    draft.setAdvisor("Muse", { model: "deepseek/new" });
    draft.setConcurrency(5);
    expect(draft.changed).toBe(true);
    expect(readFileSync(f.projectSettings, "utf8")).toBe(before);
    expect(readFileSync(f.watchdog, "utf8")).toBe(advisor);
    const fresh = await ConfigurationDraft.open(f);
    expect(fresh.concurrency).toBe(3);
    expect(fresh.advisorConfigurations[0]?.model).toBe("deepseek/original");
  } finally {
    f.cleanup();
  }
});

test("Apply writes private files and preserves prompts, inheritance, disabled advisor and unknown fields", async () => {
  const f = fixture();
  try {
    const globalBefore = readFileSync(f.settings, "utf8");
    const draft = await ConfigurationDraft.open(f);
    draft.setRole("worker", { model: "provider/new", thinking: "low" });
    draft.setAdvisor("Muse", { model: "deepseek/new" });
    draft.setConcurrency(7);
    draft.setCompaction({ model: "new", thinkingLevel: "high" });
    draft.apply();
    expect(draft.changed).toBe(false);
    expect(readFileSync(f.settings, "utf8")).toBe(globalBefore);
    const project = JSON.parse(readFileSync(f.projectSettings, "utf8"));
    expect(project.unrelated).toBe("keep");
    expect(project.subagents.agentOverrides.worker).toEqual({
      inheritGlobalContext: false,
      instructions: "exact prompt",
      model: "provider/new",
      thinking: "low",
    });
    const watchdog = parse(readFileSync(f.watchdog, "utf8"));
    expect(watchdog.main).toBe(false);
    expect(watchdog.unknown).toBe("retained");
    expect(watchdog.instructions).toBe("shared prompt");
    expect(watchdog.advisors[0]).toEqual({
      name: "Muse",
      model: "deepseek/new",
      enabled: false,
      instructions: "personal prompt",
      tools: ["read"],
      future: "preserve",
    });
    expect(readFileSync(f.watchdog, "utf8")).toContain("# Keep my header");
    const policy = JSON.parse(
      readFileSync(join(f.agentDir, "compaction-policy.json"), "utf8"),
    );
    expect(policy).toEqual({
      provider: "keep-provider",
      model: "new",
      thinkingLevel: "high",
      unknown: "retain",
    });
    expect(
      JSON.parse(
        readFileSync(
          join(f.agentDir, "extensions", "subagent", "config.json"),
          "utf8",
        ),
      ),
    ).toEqual({
      globalConcurrencyLimit: 7,
      authorityPolicy: { custom: "retain" },
    });
    for (const path of [
      f.projectSettings,
      f.watchdog,
      join(f.agentDir, "compaction-policy.json"),
    ])
      expect(statSync(path).mode & 0o777).toBe(0o600);
    const fresh = await ConfigurationDraft.open(f);
    expect(fresh.concurrency).toBe(7);
    expect(fresh.roleConfigurations[0]?.model).toBe("provider/new");
    expect(fresh.advisorEnabled).toBe(false);
    expect(readdirSync(dirname(f.projectSettings))).toEqual(["settings.json"]);
  } finally {
    f.cleanup();
  }
});

test("external changes reject all writes, including an unrelated changed inheritance file", async () => {
  const f = fixture();
  try {
    const draft = await ConfigurationDraft.open(f);
    const original = readFileSync(f.watchdog, "utf8");
    draft.setAdvisor("Muse", { model: "deepseek/new" });
    draft.setConcurrency(4);
    writeFileSync(f.settings, '{"external":"version"}');
    expect(() => draft.apply()).toThrow("changed outside Preferences");
    expect(readFileSync(f.settings, "utf8")).toBe('{"external":"version"}');
    expect(readFileSync(f.watchdog, "utf8")).toBe(original);
    expect(
      JSON.parse(
        readFileSync(
          join(f.agentDir, "extensions", "subagent", "config.json"),
          "utf8",
        ),
      ).globalConcurrencyLimit,
    ).toBe(3);
  } finally {
    f.cleanup();
  }
});

test("SDK settings lock contention refuses Apply without overwriting", async () => {
  const f = fixture();
  const locks = createRequire(import.meta.url)("proper-lockfile");
  let release: (() => void) | undefined;
  try {
    const draft = await ConfigurationDraft.open(f);
    const original = readFileSync(f.projectSettings, "utf8");
    draft.setRole("worker", { thinking: "low" });
    release = locks.lockSync(f.projectSettings, { realpath: false });
    expect(() => draft.apply()).toThrow("Settings were not applied");
    expect(readFileSync(f.projectSettings, "utf8")).toBe(original);
  } finally {
    release?.();
    f.cleanup();
  }
});

test("malformed JSON fails closed; malformed advisor remains unavailable and cannot be overwritten", async () => {
  const f = fixture();
  try {
    f.put(f.settings, "{invalid");
    await expect(ConfigurationDraft.open(f)).rejects.toThrow(
      "refusing to overwrite",
    );
    expect(readFileSync(f.settings, "utf8")).toBe("{invalid");
    f.put(f.settings, "{}");
    f.put(f.watchdog, "advisors: [invalid");
    const draft = await ConfigurationDraft.open(f);
    expect(draft.advisorAvailable).toBe(false);
    expect(() => draft.setAdvisorEnabled(true)).toThrow("unavailable");
    expect(readFileSync(f.watchdog, "utf8")).toBe("advisors: [invalid");
  } finally {
    f.cleanup();
  }
});

test("missing modules degrade to unavailable and worker limit rejects invalid values", async () => {
  const f = fixture();
  try {
    const draft = await ConfigurationDraft.open({
      ...f,
      subagentsPath: join(f.root, "missing"),
      advisorPath: join(f.root, "absent"),
    });
    expect(draft.unavailable.length).toBe(2);
    expect(draft.subagentsAvailable).toBe(false);
    expect(draft.advisorAvailable).toBe(false);
    expect(draft.compactionAvailable).toBe(false);
    expect(() => draft.setConcurrency(2)).toThrow("unavailable");
    const available = await ConfigurationDraft.open(f);
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => available.setConcurrency(value)).toThrow("positive integer");
  } finally {
    f.cleanup();
  }
});

test("malformed optional settings leave main preferences available without overwriting files", async () => {
  const f = fixture();
  try {
    const limits = join(f.agentDir, "extensions", "subagent", "config.json");
    const compaction = join(f.agentDir, "compaction-policy.json");
    f.put(limits, "{invalid limits");
    f.put(compaction, "{invalid compaction");
    const before = readFileSync(f.settings, "utf8");
    const draft = await ConfigurationDraft.open(f);
    expect(draft.subagentsAvailable).toBe(false);
    expect(draft.compactionAvailable).toBe(false);
    expect(draft.advisorAvailable).toBe(true);
    expect(draft.unavailable.some((message) => message.includes(limits))).toBe(
      true,
    );
    expect(draft.unavailable.some((message) => message.includes(compaction))).toBe(
      true,
    );
    expect(() => draft.setConcurrency(2)).toThrow("unavailable");
    expect(() => draft.setCompaction({ model: "replacement" })).toThrow(
      "unavailable",
    );
    draft.setMain({ model: "replacement" });
    expect(readFileSync(f.settings, "utf8")).toBe(before);
    draft.apply();
    expect(JSON.parse(readFileSync(f.settings, "utf8")).defaultModel).toBe(
      "replacement",
    );
    expect(readFileSync(limits, "utf8")).toBe("{invalid limits");
    expect(readFileSync(compaction, "utf8")).toBe("{invalid compaction");
  } finally {
    f.cleanup();
  }
});
