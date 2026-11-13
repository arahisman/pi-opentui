import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import {
  ConfigurationDraft,
  type ConfigurationOptions,
  type RoleConfiguration,
} from "../core/configuration.ts";
import type { PiHost } from "../host/controller.ts";
import type { MenuItem, OverlayManager } from "./overlays.ts";

type Host = Pick<
  PiHost,
  "options" | "session" | "selectModel" | "setThinking" | "reload"
>;
type Model = ReturnType<Host["session"]["modelRuntime"]["getModels"]>[number];
type Thinking = Parameters<Host["setThinking"]>[0];
export interface DisplaySettings {
  sidebarVisible: boolean;
  thinkingExpanded: boolean;
  toolsExpanded: boolean;
  toolDisplay?: "collapsed" | "compact" | "full";
}
export interface SettingsCallbacks {
  getDisplay?(): DisplaySettings;
  applyDisplay?(display: DisplaySettings): void | Promise<void>;
  onApplied?(): void;
  loadConfiguration?(
    options: ConfigurationOptions,
    trusted: boolean,
  ): Promise<ConfigurationDraft>;
}
export class SettingsPanel {
  private draft?: ConfigurationDraft;
  private display?: DisplaySettings;
  private originalDisplay?: DisplaySettings;
  private mainModel?: Model;
  private thinking?: Thinking;
  private originalModel?: Model;
  private originalThinking?: Thinking;
  private session?: Host["session"];
  private projectCwd?: string;
  private tab = 1;
  private generation = 0;
  private applying = false;
  private replacing = false;
  constructor(
    private readonly host: Host,
    private readonly overlay: Pick<
      OverlayManager,
      "openMenu" | "openInput" | "openText" | "close"
    >,
    private readonly callbacks: SettingsCallbacks = {},
  ) {}
  async open(): Promise<void> {
    const generation = ++this.generation;
    try {
      const session = this.host.session;
      const cwd = session.sessionManager.getCwd();
      const model = session.model;
      const thinking = session.thinkingLevel;
      const options = {
        cwd,
        agentDir: this.host.options.agentDir!,
        preferredModelProvider: model?.provider,
      };
      const draft = await (
        this.callbacks.loadConfiguration ?? ConfigurationDraft.open
      )(options, session.settingsManager.isProjectTrusted());
      if (generation !== this.generation) return;
      if (
        this.host.session !== session ||
        this.host.session.sessionManager.getCwd() !== cwd
      )
        throw new Error(
          "Session or project changed while Preferences were loading. Reopen Preferences before applying.",
        );
      if (session.model !== model || session.thinkingLevel !== thinking)
        throw new Error(
          "Model changed while Preferences were loading. Reopen Preferences before applying.",
        );
      this.draft = draft;
      this.session = session;
      this.projectCwd = cwd;
      this.originalModel = this.mainModel = model;
      this.originalThinking = this.thinking = thinking;
      this.originalDisplay = this.callbacks.getDisplay?.();
      this.display = this.originalDisplay && { ...this.originalDisplay };
      this.applying = false;
      this.show();
    } catch (error) {
      this.error(error);
    }
  }
  private get changed(): boolean {
    return (
      !!this.draft?.changed ||
      this.mainModel !== this.originalModel ||
      this.thinking !== this.originalThinking ||
      JSON.stringify(this.display) !== JSON.stringify(this.originalDisplay)
    );
  }
  private route(model?: Model): string {
    return model ? `${model.provider}/${model.id}` : "Follow session";
  }
  private show(): void {
    const draft = this.draft;
    if (!draft || this.applying) return;
    const items: MenuItem[] = [];
    if (this.tab === 0 || this.tab === 1) {
      items.push(
        {
          id: "main",
          label: "Main agent",
          description: this.route(this.mainModel),
        },
        {
          id: "reasoning",
          label: "Main reasoning",
          description: this.thinking,
        },
      );
    }
    if (this.tab === 1) {
      items.push({
        id: "roles",
        label: "Subagent roles",
        description: draft.subagentsAvailable
          ? `${draft.roleConfigurations.length} installed roles`
          : "Unavailable",
      });
      items.push({
        id: "advisor",
        label: "Advisor",
        description: draft.advisorAvailable
          ? `${draft.advisorEnabled ? "on" : "off"} · ${draft.advisorConfigurations.map((advisor) => `${advisor.name}: ${advisor.model ?? "follow session"}${advisor.enabled === false ? " (disabled)" : ""}`).join(", ") || "implicit session advisor"}`
          : "Unavailable",
      });
      items.push({
        id: "compaction",
        label: "Compaction",
        description: this.compactionLabel(),
      });
      items.push({
        id: "workers",
        label: "Max workers",
        description: draft.subagentsAvailable
          ? String(draft.concurrency ?? "module default")
          : "Unavailable",
      });
    }
    if (this.tab === 2)
      items.push(
        {
          id: "compaction",
          label: "Compaction model",
          description: this.compactionLabel(),
        },
        {
          id: "compaction-thinking",
          label: "Compaction reasoning",
          description:
            draft.compactionConfiguration.thinkingLevel ?? "module default",
        },
      );
    if (this.tab === 3 && this.display) {
      items.push(
        {
          id: "sidebar",
          label: "Sidebar",
          description: this.display.sidebarVisible ? "shown" : "hidden",
        },
        {
          id: "thinking",
          label: "Reasoning blocks",
          description: this.display.thinkingExpanded ? "expanded" : "collapsed",
        },
        {
          id: "tools",
          label: "Tool output",
          description:
            this.display.toolDisplay ??
            (this.display.toolsExpanded ? "full" : "collapsed"),
        },
      );
    }
    if (this.tab === 3 && !this.display)
      items.push({ id: "unavailable", label: "Display settings unavailable" });
    items.push(
      {
        id: "apply",
        label: "[ Apply ]",
        description: this.changed
          ? "Changes not applied · next safe boundary"
          : "No changes",
      },
      { id: "cancel", label: "[ Cancel ]", description: "Discard changes" },
    );
    this.replacing = true;
    this.overlay.openMenu({
      title: "Preferences",
      tabs: ["General", "Models", "Context", "Display"],
      tabIndex: this.tab,
      items,
      onTab: (index) => {
        this.tab = index;
        this.show();
      },
      onCancel: () => {
        if (!this.replacing) this.cancel(false);
      },
      onSelect: (id) => this.select(id),
    });
    this.replacing = false;
  }
  private async select(id: string): Promise<void> {
    const draft = this.draft;
    if (!draft) return;
    if (id === "cancel") {
      this.cancel();
      return;
    }
    if (id === "apply") {
      await this.apply();
      return;
    }
    if (id === "main") {
      this.chooseModel("Main agent", this.mainModel, (model) => {
        this.mainModel = model;
        draft.setMain({ provider: model.provider, model: model.id });
        const supported = getSupportedThinkingLevels(model);
        if (!supported.includes(this.thinking!)) {
          this.thinking = supported[0];
          draft.setMain({ thinkingLevel: this.thinking });
        }
        this.show();
      });
      return;
    }
    if (id === "reasoning") {
      this.chooseThinking("Main reasoning", this.mainModel, (value) => {
        this.thinking = value;
        draft.setMain({ thinkingLevel: value });
        this.show();
      });
      return;
    }
    if (id === "roles" && draft.subagentsAvailable) {
      this.roles();
      return;
    }
    if (id === "advisor" && draft.advisorAvailable) {
      this.advisors();
      return;
    }
    if (
      (id === "compaction" || id === "compaction-thinking") &&
      !draft.compactionAvailable
    ) {
      this.notice(
        "Compaction controls unavailable for this agent directory or module installation",
      );
      return;
    }
    if (id === "compaction") {
      const config = draft.compactionConfiguration;
      const current = this.findRoute(config.model, config.provider);
      this.chooseModel("Compaction model", current, (model) => {
        draft.setCompaction({ provider: model.provider, model: model.id });
        this.show();
      });
      return;
    }
    if (id === "compaction-thinking") {
      const config = draft.compactionConfiguration;
      const model = this.findRoute(config.model, config.provider);
      if (!model) {
        this.notice("Choose a compaction model from the current catalog first");
        return;
      }
      this.chooseThinking("Compaction reasoning", model, (value) => {
        draft.setCompaction({ thinkingLevel: value });
        this.show();
      });
      return;
    }
    if (id === "workers" && draft.subagentsAvailable) {
      this.overlay.openInput({
        title: "Max workers · global concurrency limit",
        value: draft.concurrency === undefined ? "" : String(draft.concurrency),
        onCancel: () => this.show(),
        onSubmit: (value) => {
          try {
            draft.setConcurrency(Number(value));
            this.show();
          } catch (error) {
            this.error(error);
          }
        },
      });
      return;
    }
    if (this.display) {
      if (id === "sidebar")
        this.display.sidebarVisible = !this.display.sidebarVisible;
      if (id === "thinking")
        this.display.thinkingExpanded = !this.display.thinkingExpanded;
      if (id === "tools") {
        const modes = ["collapsed", "compact", "full"] as const;
        const current =
          this.display.toolDisplay ??
          (this.display.toolsExpanded ? "full" : "compact");
        this.display.toolDisplay =
          modes[(modes.indexOf(current) + 1) % modes.length]!;
        this.display.toolsExpanded = this.display.toolDisplay === "full";
      }
    }
    this.show();
  }
  private findRoute(route?: string, provider?: string): Model | undefined {
    if (!route) return undefined;
    return this.host.session.modelRuntime
      .getModels()
      .find((model) =>
        provider
          ? model.provider === provider && model.id === route
          : `${model.provider}/${model.id}` === route,
      );
  }
  private compactionLabel(): string {
    if (!this.draft!.compactionAvailable) return "Unavailable";
    const config = this.draft!.compactionConfiguration;
    return `${config.provider ? `${config.provider}/` : ""}${config.model ?? "module default"} · ${config.thinkingLevel ?? "module default"}`;
  }
  private chooseModel(
    title: string,
    current: Model | undefined,
    onSelect: (model: Model) => void,
    back = () => this.show(),
  ): void {
    const models = this.host.session.modelRuntime.getModels();
    this.overlay.openMenu({
      title,
      items: models.map((model) => ({
        id: `${model.provider}/${model.id}`,
        label: `${current?.provider === model.provider && current?.id === model.id ? "●" : "○"} ${model.name}`,
        description: `${model.provider}/${model.id}${this.host.session.modelRuntime.hasConfiguredAuth(model.provider) ? "" : " · not connected"}`,
      })),
      onCancel: back,
      onSelect: (route) => {
        const model = models.find(
          (candidate) => `${candidate.provider}/${candidate.id}` === route,
        );
        if (!model) throw new Error("Model is no longer in the catalog");
        if (!this.host.session.modelRuntime.hasConfiguredAuth(model.provider)) {
          this.notice("Connect this provider before choosing its model", back);
          return;
        }
        onSelect(model);
      },
    });
  }
  private chooseThinking(
    title: string,
    model: Model | undefined,
    onSelect: (value: Thinking) => void,
    back = () => this.show(),
  ): void {
    const levels = model
      ? getSupportedThinkingLevels(model)
      : this.host.session.getAvailableThinkingLevels();
    this.overlay.openMenu({
      title,
      items: levels.map((level) => ({ id: level, label: level })),
      onCancel: back,
      onSelect: (level) => {
        if (!levels.includes(level as Thinking))
          throw new Error("Reasoning level is no longer supported");
        onSelect(level as Thinking);
      },
    });
  }
  private roles(): void {
    const roles = this.draft!.roleConfigurations;
    this.overlay.openMenu({
      title: "Subagent roles",
      items: roles.map((role) => ({
        id: role.name,
        label: role.name,
        description: `${role.model ?? "inherit"} · ${role.thinking === false ? "off" : (role.thinking ?? "inherit")}`,
      })),
      onCancel: () => this.show(),
      onSelect: (name) => {
        const role = roles.find((role) => role.name === name);
        if (role) this.role(role);
      },
    });
  }
  private role(role: RoleConfiguration): void {
    const draft = this.draft!;
    this.overlay.openMenu({
      title: `Subagent · ${role.name}`,
      items: [
        { id: "model", label: "Model", description: role.model ?? "inherit" },
        {
          id: "thinking",
          label: "Reasoning",
          description: String(role.thinking ?? "inherit"),
        },
        { id: "back", label: "Back" },
      ],
      onCancel: () => this.roles(),
      onSelect: (id) => {
        const current = this.findRoute(
          role.model,
          role.model?.includes("/") ? undefined : role.modelProvider,
        );
        if (id === "model")
          this.chooseModel(
            `Model · ${role.name}`,
            current,
            (model) => {
              draft.setRole(role.name, {
                model: `${model.provider}/${model.id}`,
              });
              this.roles();
            },
            () => this.role(role),
          );
        else if (id === "thinking") {
          if (!current) {
            this.notice(
              "Choose an explicit role model first so supported reasoning can be verified",
              () => this.role(role),
            );
            return;
          }
          this.chooseThinking(
            `Reasoning · ${role.name}`,
            current,
            (thinking) => {
              draft.setRole(role.name, { thinking });
              this.roles();
            },
            () => this.role(role),
          );
        } else this.roles();
      },
    });
  }
  private advisors(): void {
    const draft = this.draft!;
    const roster = draft.advisorConfigurations;
    this.overlay.openMenu({
      title: "Advisor",
      items: [
        {
          id: "enabled",
          label: "Main-session advisor",
          description: draft.advisorEnabled ? "on" : "off",
        },
        ...roster.map((advisor) => ({
          id: `advisor:${advisor.name}`,
          label: advisor.name,
          description: `${advisor.model ?? "follow session"} · ${advisor.enabled === false ? "disabled" : "enabled"}`,
        })),
        { id: "back", label: "Back" },
      ],
      onCancel: () => this.show(),
      onSelect: (id) => {
        if (id === "enabled") {
          draft.setAdvisorEnabled(!draft.advisorEnabled);
          this.advisors();
        } else if (id.startsWith("advisor:")) {
          const advisor = roster.find(
            (advisor) => advisor.name === id.slice(8),
          );
          if (!advisor) return;
          this.overlay.openMenu({
            title: `Advisor · ${advisor.name}`,
            items: [
              {
                id: "model",
                label: "Model",
                description: advisor.model ?? "follow session",
              },
              {
                id: "enabled",
                label: "Enabled",
                description: advisor.enabled === false ? "off" : "on",
              },
              { id: "back", label: "Back" },
            ],
            onCancel: () => this.advisors(),
            onSelect: (action) => {
              if (action === "model")
                this.chooseModel(
                  `Advisor model · ${advisor.name}`,
                  this.findRoute(advisor.model),
                  (model) => {
                    draft.setAdvisor(advisor.name, {
                      model: `${model.provider}/${model.id}`,
                    });
                    this.advisors();
                  },
                  () => this.advisors(),
                );
              else if (action === "enabled") {
                draft.setAdvisor(advisor.name, {
                  enabled: advisor.enabled === false,
                });
                this.advisors();
              } else this.advisors();
            },
          });
        } else this.show();
      },
    });
  }
  private assertTarget(): void {
    if (
      this.session !== this.host.session ||
      this.host.session.sessionManager.getCwd() !== this.projectCwd
    )
      throw new Error(
        "Session or project changed while Preferences were open. Reopen Preferences before applying.",
      );
  }
  async apply(): Promise<void> {
    if (!this.draft || this.applying) return;
    const draft = this.draft;
    const generation = this.generation;
    this.applying = true;
    this.replacing = true;
    this.overlay.openMenu({
      title: "Preferences · next safe boundary",
      items: [
        {
          id: "cancel",
          label: "Cancel pending Apply",
          description: "Waiting for current work to finish",
        },
      ],
      onSelect: () => this.cancel(),
      onCancel: () => {
        if (!this.replacing) this.cancel(false);
      },
    });
    this.replacing = false;
    try {
      this.assertTarget();
      await this.session!.waitForIdle();
      if (generation !== this.generation) return;
      this.assertTarget();
      if (
        this.host.session.model !== this.originalModel ||
        this.host.session.thinkingLevel !== this.originalThinking
      )
        throw new Error(
          "Session or model changed while Preferences were open. Reopen Preferences before applying.",
        );
      draft.assertUnchanged();
      const reload = draft.changed;
      draft.apply();
      if (reload) await this.host.reload();
      if (generation !== this.generation) return;
      this.assertTarget();
      if (this.mainModel && this.mainModel !== this.originalModel)
        await this.host.selectModel(this.mainModel.provider, this.mainModel.id);
      if (generation !== this.generation) return;
      this.assertTarget();
      if (
        this.thinking !== undefined &&
        (this.thinking !== this.originalThinking ||
          this.mainModel !== this.originalModel)
      )
        this.host.setThinking(this.thinking);
      if (
        this.display &&
        JSON.stringify(this.display) !== JSON.stringify(this.originalDisplay)
      )
        await this.callbacks.applyDisplay?.(this.display);
      this.draft = undefined;
      this.applying = false;
      this.overlay.close();
      this.callbacks.onApplied?.();
    } catch (error) {
      this.applying = false;
      this.error(error);
    }
  }
  cancel(close = true): void {
    ++this.generation;
    this.draft = undefined;
    this.applying = false;
    if (close) this.overlay.close();
  }
  private notice(message: string, back = () => this.show()): void {
    this.overlay.openText({
      title: "Preferences",
      body: message,
      actions: [{ id: "back", label: "Back" }],
      onAction: back,
    });
  }
  private error(error: unknown): void {
    this.notice(error instanceof Error ? error.message : String(error));
  }
}
