import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { parse, parseDocument } from "yaml";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const lockfile = require("proper-lockfile") as {
  lockSync(path: string, options: { realpath: false }): () => void;
};
type Mapping = Record<string, unknown>;
function mapping(value: unknown, label: string): Mapping {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label}: expected an object`);
  return value as Mapping;
}
const optionalMapping = (value: unknown, label: string): Mapping =>
  value === undefined ? {} : mapping(value, label);
export interface RoleConfiguration {
  name: string;
  model?: string;
  modelProvider?: string;
  thinking?: string | false;
  source?: string;
}
export interface AdvisorConfiguration {
  name: string;
  model?: string;
  enabled?: boolean;
  [key: string]: unknown;
}
interface ConfigFile {
  requested: string;
  path: string;
  raw: string | undefined;
  value: Mapping;
  yaml: boolean;
  dirty: boolean;
}
export interface ConfigurationOptions {
  cwd: string;
  agentDir: string;
  subagentsPath?: string;
  advisorPath?: string;
  preferredModelProvider?: string;
}
interface SubagentsModule {
  discoverAgentSnapshot(
    cwd: string,
    scope: "both",
    preferredProvider?: string,
    options?: { globalNpmRoot: null; projectTrusted: boolean },
  ): {
    effective: { agents: RoleConfiguration[] };
    all: { userSettingsPath: string; projectSettingsPath: string | null };
  };
}
interface AdvisorModule {
  collectConfigCandidates(
    cwd: string,
    agentDir: string,
    filenames: string[],
  ): Promise<{ path: string; content: string }[]>;
}
function read(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
function physical(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  return existsSync(dirname(path))
    ? join(realpathSync(dirname(path)), basename(path))
    : path;
}
export class ConfigurationDraft {
  private files = new Map<string, ConfigFile>();
  private settings!: ConfigFile;
  private projectSettings?: ConfigFile;
  private limits?: ConfigFile;
  private compaction?: ConfigFile;
  private advisorFiles: ConfigFile[] = [];
  private advisorTarget?: ConfigFile;
  private roles: RoleConfiguration[] = [];
  private rolePatches = new Map<
    string,
    { model?: string; thinking?: string | false }
  >();
  private lease?: <T>(path: string, callback: () => T) => T;
  readonly unavailable: string[] = [];
  subagentsAvailable = false;
  advisorAvailable = false;
  compactionAvailable = false;
  private constructor(readonly options: ConfigurationOptions) {}
  static async open(
    options: ConfigurationOptions,
    projectTrusted = true,
  ): Promise<ConfigurationDraft> {
    const draft = new ConfigurationDraft(options);
    draft.settings = draft.load(join(options.agentDir, "settings.json"));
    try {
      draft.compaction = draft.load(
        join(options.agentDir, "compaction-policy.json"),
      );
    } catch (error) {
      draft.unavailable.push(
        `Compaction unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    draft.compactionAvailable =
      !!draft.compaction &&
      physical(resolve(options.agentDir)) ===
        physical(join(homedir(), ".pi", "agent")) &&
      existsSync(
        join(
          options.agentDir,
          "local-packages",
          "experiment",
          "extensions",
          "index.ts",
        ),
      );
    const subagentsPath =
      options.subagentsPath ??
      join(options.agentDir, "local-packages", "subagents");
    const agentsFile = join(subagentsPath, "src", "agents", "agents.js");
    if (existsSync(agentsFile)) {
      try {
        draft.limits = draft.load(
          join(options.agentDir, "extensions", "subagent", "config.json"),
        );
        const module = (await import(
          pathToFileURL(agentsFile).href
        )) as SubagentsModule;
        const result = module.discoverAgentSnapshot(
          options.cwd,
          "both",
          options.preferredModelProvider,
          { globalNpmRoot: null, projectTrusted },
        );
        if (
          physical(resolve(result.all.userSettingsPath)) !== draft.settings.path
        )
          throw new Error(
            "Subagents use a different agent directory; use its native configuration command",
          );
        draft.roles = result.effective.agents;
        if (result.all.projectSettingsPath)
          draft.projectSettings = draft.load(result.all.projectSettingsPath);
        const leases = await import(
          pathToFileURL(
            join(subagentsPath, "src", "shared", "settings-file-lease.js"),
          ).href
        );
        draft.lease = leases.withSettingsFileLease;
        draft.subagentsAvailable = true;
      } catch (error) {
        draft.unavailable.push(
          `Subagents unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else
      draft.unavailable.push("Subagents unavailable: module is not installed");
    const advisorPath =
      options.advisorPath ??
      join(options.agentDir, "local-packages", "advisor");
    const watchdogFile = join(
      advisorPath,
      "src",
      "advisor",
      "watchdog-config.ts",
    );
    if (existsSync(watchdogFile)) {
      try {
        const loader = createJiti(import.meta.url, {
          fsCache: false,
          moduleCache: false,
          tryNative: false,
          virtualModules: {
            "@earendil-works/pi-coding-agent":
              await import("@earendil-works/pi-coding-agent"),
            "@earendil-works/pi-ai":
              await import("@earendil-works/pi-ai/compat"),
            yaml: await import("yaml"),
          },
        });
        const module = await loader.import<AdvisorModule>(watchdogFile);
        const candidates = await module.collectConfigCandidates(
          options.cwd,
          options.agentDir,
          ["WATCHDOG.yml", "WATCHDOG.yaml"],
        );
        draft.advisorFiles = candidates.map((item) =>
          draft.load(item.path, true),
        );
        draft.advisorTarget =
          draft.advisorFiles.at(-1) ??
          draft.load(join(options.cwd, "WATCHDOG.yml"), true);
        draft.advisorAvailable = true;
      } catch (error) {
        draft.unavailable.push(
          `Advisor unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else
      draft.unavailable.push("Advisor unavailable: module is not installed");
    return draft;
  }
  private load(path: string, yaml = false): ConfigFile {
    const requested = resolve(path);
    path = physical(requested);
    const existing = this.files.get(path);
    if (existing) return existing;
    const raw = read(path);
    let value: Mapping = {};
    if (raw !== undefined) {
      try {
        value = mapping(yaml ? (parse(raw) ?? {}) : JSON.parse(raw), path);
      } catch (error) {
        throw new Error(
          `Cannot parse settings ${path}; refusing to overwrite`,
          { cause: error },
        );
      }
    }
    const file = { requested, path, raw, value, yaml, dirty: false };
    this.files.set(path, file);
    return file;
  }
  get changed(): boolean {
    return [...this.files.values()].some((file) => file.dirty);
  }
  setMain(patch: {
    provider?: string;
    model?: string;
    thinkingLevel?: string;
  }): void {
    if (patch.provider !== undefined)
      this.settings.value.defaultProvider = patch.provider;
    if (patch.model !== undefined)
      this.settings.value.defaultModel = patch.model;
    if (patch.thinkingLevel !== undefined)
      this.settings.value.defaultThinkingLevel = patch.thinkingLevel;
    this.settings.dirty = true;
  }
  get roleConfigurations(): RoleConfiguration[] {
    return this.roles.map((role) => ({
      ...role,
      ...this.rolePatches.get(role.name),
    }));
  }
  setRole(
    name: string,
    patch: { model?: string; thinking?: string | false },
  ): void {
    if (
      !this.subagentsAvailable ||
      !this.roles.some((role) => role.name === name)
    )
      throw new Error("Subagent role is unavailable");
    const file = this.projectSettings ?? this.settings;
    const subagents = optionalMapping(file.value.subagents, "subagents");
    const overrides = optionalMapping(
      subagents.agentOverrides,
      "agentOverrides",
    );
    file.value = {
      ...file.value,
      subagents: {
        ...subagents,
        agentOverrides: {
          ...overrides,
          [name]: { ...optionalMapping(overrides[name], name), ...patch },
        },
      },
    };
    file.dirty = true;
    this.rolePatches.set(name, { ...this.rolePatches.get(name), ...patch });
  }
  get concurrency(): number | undefined {
    return typeof this.limits?.value.globalConcurrencyLimit === "number"
      ? this.limits.value.globalConcurrencyLimit
      : undefined;
  }
  setConcurrency(value: number): void {
    if (!this.subagentsAvailable || !this.limits)
      throw new Error("Subagents unavailable");
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error("Max workers must be a positive integer");
    this.limits.value.globalConcurrencyLimit = value;
    this.limits.dirty = true;
  }
  get compactionConfiguration(): {
    provider?: string;
    model?: string;
    thinkingLevel?: string;
  } {
    return structuredClone(this.compaction?.value ?? {});
  }
  setCompaction(patch: {
    provider?: string;
    model?: string;
    thinkingLevel?: string;
  }): void {
    if (!this.compaction) throw new Error("Compaction unavailable");
    this.compaction.value = { ...this.compaction.value, ...patch };
    this.compaction.dirty = true;
  }
  get advisorEnabled(): boolean {
    let enabled = true;
    for (const file of this.advisorFiles)
      if (typeof file.value.main === "boolean") enabled = file.value.main;
    if (typeof this.advisorTarget?.value.main === "boolean")
      enabled = this.advisorTarget.value.main;
    return enabled;
  }
  get advisorConfigurations(): AdvisorConfiguration[] {
    const roster = new Map<string, AdvisorConfiguration>();
    for (const file of new Set(
      [...this.advisorFiles, this.advisorTarget].filter(
        (file): file is ConfigFile => !!file,
      ),
    )) {
      if (file.value.advisors === undefined) continue;
      if (!Array.isArray(file.value.advisors))
        throw new Error("Advisor roster must be an array");
      for (const entry of file.value.advisors) {
        const advisor = mapping(entry, "Advisor");
        if (typeof advisor.name !== "string")
          throw new Error("Advisor name is missing");
        const key =
          advisor.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "advisor";
        roster.set(key, { ...advisor } as AdvisorConfiguration);
      }
    }
    return [...roster.values()];
  }
  setAdvisorEnabled(enabled: boolean): void {
    if (!this.advisorAvailable || !this.advisorTarget)
      throw new Error("Advisor unavailable");
    this.advisorTarget.value.main = enabled;
    this.advisorTarget.dirty = true;
  }
  setAdvisor(name: string, patch: { model?: string; enabled?: boolean }): void {
    if (!this.advisorAvailable || !this.advisorTarget)
      throw new Error("Advisor unavailable");
    const effective = this.advisorConfigurations.find(
      (advisor) => advisor.name === name,
    );
    if (!effective) throw new Error("Advisor is unavailable");
    const file = this.advisorTarget;
    const entries =
      file.value.advisors === undefined
        ? []
        : (file.value.advisors as Mapping[]);
    const index = entries.findIndex((advisor) => advisor.name === name);
    const next = [...entries];
    if (index < 0) next.push({ ...effective, ...patch });
    else next[index] = { ...next[index], ...patch };
    file.value.advisors = next;
    file.dirty = true;
  }
  assertUnchanged(): void {
    for (const file of this.files.values())
      if (
        physical(file.requested) !== file.path ||
        read(file.path) !== file.raw
      )
        throw new Error(
          `Settings changed outside Preferences: ${file.path}. Reopen Preferences before applying.`,
        );
  }
  apply(): void {
    const dirty = [...this.files.values()].filter((file) => file.dirty);
    if (!dirty.length) return;
    const releases: (() => void)[] = [];
    const temporary: string[] = [];
    let committed = 0;
    const commit = () => {
      this.assertUnchanged();
      for (const file of dirty) {
        mkdirSync(dirname(file.path), { recursive: true, mode: 0o700 });
        for (const path of new Set([
          join(realpathSync(dirname(file.requested)), basename(file.requested)),
          file.path,
        ]))
          releases.push(lockfile.lockSync(path, { realpath: false }));
      }
      this.assertUnchanged();
      const writes = dirty.map((file) => {
        let content: string;
        if (file.yaml) {
          const doc = parseDocument(file.raw ?? "");
          for (const key of ["main", "advisors"])
            if (Object.hasOwn(file.value, key)) doc.set(key, file.value[key]);
          content = doc.toString();
        } else content = JSON.stringify(file.value, null, 2) + "\n";
        const temp = `${file.path}.${randomUUID()}.tmp`;
        const descriptor = openSync(temp, "wx", 0o600);
        temporary.push(temp);
        try {
          writeFileSync(descriptor, content, "utf8");
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
        return { file, temp, content };
      });
      this.assertUnchanged();
      for (const { file, temp, content } of writes) {
        renameSync(temp, file.path);
        committed++;
        file.raw = content;
        file.dirty = false;
      }
    };
    try {
      const scoped = (index: number): void => {
        const path = dirty.filter(
          (file) => file === this.settings || file === this.projectSettings,
        )[index]?.path;
        if (path && this.lease) this.lease(path, () => scoped(index + 1));
        else commit();
      };
      scoped(0);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        committed
          ? `Applied ${committed} settings file(s), but remaining changes failed; reopen Preferences: ${detail}`
          : `Settings were not applied: ${detail}`,
        { cause: error },
      );
    } finally {
      try {
        for (const path of temporary) {
          try {
            unlinkSync(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      } finally {
        for (const release of releases.reverse()) release();
      }
    }
  }
}
