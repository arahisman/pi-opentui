import {
  executeConnectionAction,
  readConnectionLog,
  readConnections,
  type ConnectionRecord,
  type ConnectionSnapshot,
  type ConnectionsHost,
} from "../core/connections.ts";
import type { OverlayManager } from "./overlays.ts";
export interface ConnectionsPanelOptions {
  onProviders?: () => void | Promise<void>;
  onExtensions?: () => void | Promise<void>;
}
export class ConnectionsPanel {
  constructor(
    private readonly host: ConnectionsHost,
    private readonly overlays: OverlayManager,
    private readonly options: ConnectionsPanelOptions = {},
  ) {}
  async open(): Promise<void> {
    try {
      const snapshot = await readConnections(this.host);
      this.overlays.openMenu({
        title: "Connections",
        items: [
          {
            id: "providers",
            label: "Providers",
            description: `${snapshot.providers.filter((provider) => provider.configured).length} with configured auth · network health unverified`,
          },
          ...snapshot.mcp.map((row) => ({
            id: row.id,
            label: `MCP · ${row.name}`,
            description:
              row.state === "unknown"
                ? `unknown · ${row.summary}`
                : row.summary,
          })),
          {
            id: "mcp-manager",
            label: snapshot.mcp.length
              ? "Manage MCP servers"
              : "MCP · no servers reported",
            description: snapshot.mcpAvailable
              ? "Native status, sign-in, retry and configuration"
              : "Optional MCP controls are not loaded",
          },
          {
            id: "lsp",
            label: "Language servers",
            description: `${snapshot.lsp.state} · ${snapshot.lsp.summary}`,
          },
          {
            id: "diagnostics",
            label: "Diagnostics & logs",
            description: `${snapshot.diagnostics.length} reported messages`,
          },
          { id: "refresh", label: "Refresh status" },
          ...(this.options.onExtensions
            ? [{ id: "extensions", label: "Extensions" }]
            : []),
        ],
        onSelect: async (id) => {
          if (id === "refresh") return this.open();
          if (id === "providers") {
            if (this.options.onProviders) return this.options.onProviders();
            return this.providers(snapshot);
          }
          if (id === "extensions") return this.options.onExtensions?.();
          if (id === "diagnostics") return this.diagnostics(snapshot);
          if (id === "mcp-manager") {
            if (snapshot.mcpAvailable)
              return executeConnectionAction(this.host, {
                kind: "mcp-manager",
              });
            return this.overlays.openText({
              title: "MCP",
              body: "MCP native controls are not loaded. No connected state has been inferred.",
            });
          }
          const row =
            id === "lsp"
              ? snapshot.lsp
              : snapshot.mcp.find((item) => item.id === id);
          if (row) this.detail(snapshot, row);
        },
      });
    } catch (error) {
      this.error(error);
    }
  }
  private providers(snapshot: ConnectionSnapshot): void {
    this.overlays.openText({
      title: "Provider configuration",
      body: [
        ...snapshot.providers.map(
          (provider) =>
            `${provider.name}: ${provider.configured ? "auth configured" : "auth not configured"}`,
        ),
        "",
        "Configured authentication does not prove a live connection.",
      ].join("\n"),
      actions: [{ id: "back", label: "Back" }],
      onAction: () => this.open(),
    });
  }
  private detail(snapshot: ConnectionSnapshot, row: ConnectionRecord): void {
    const available =
      row.kind === "mcp" ? snapshot.mcpAvailable : snapshot.lspAvailable;
    this.overlays.openText({
      title: row.kind === "mcp" ? `MCP · ${row.name}` : "Language servers",
      body: [
        `State: ${row.state}`,
        row.summary,
        `Source: ${row.source}`,
        "",
        ...(row.kind === "lsp"
          ? [
              "Counts describe active clients reported by the LSP module, not per-server health.",
              "Native controls show individual server installation/process state.",
            ]
          : ["Observed native status is a snapshot; refresh to check again."]),
        ...(!available
          ? ["Native controls are not loaded in this session."]
          : []),
      ].join("\n"),
      actions: [
        ...(available ? [{ id: "manage", label: "Native controls" }] : []),
        ...(row.kind === "mcp" && row.state !== "disabled" && row.retryName
          ? [{ id: "retry", label: "Retry" }]
          : []),
        ...(row.kind === "lsp" && available
          ? [
              { id: "doctor", label: "Diagnostics" },
              { id: "retry", label: "Restart servers" },
            ]
          : []),
        ...(row.kind === "mcp" ? [{ id: "logs", label: "Logs" }] : []),
        { id: "back", label: "Back" },
      ],
      onAction: async (action) => {
        try {
          if (action === "back") return this.open();
          if (action === "logs") return this.logs(snapshot);
          if (action === "manage")
            return executeConnectionAction(this.host, {
              kind: row.kind === "mcp" ? "mcp-manager" : "lsp-manager",
            });
          if (action === "doctor")
            return executeConnectionAction(this.host, {
              kind: "lsp-diagnostics",
            });
          if (action === "retry") {
            await executeConnectionAction(
              this.host,
              row.kind === "mcp"
                ? { kind: "mcp-retry", name: row.retryName! }
                : { kind: "lsp-retry" },
            );
            return this.open();
          }
        } catch (error) {
          this.error(error);
        }
      },
    });
  }
  private diagnostics(snapshot: ConnectionSnapshot): void {
    this.overlays.openText({
      title: "Connection diagnostics",
      body:
        snapshot.diagnostics.join("\n\n") ||
        "No MCP/LSP or extension diagnostics reported. This does not prove connectivity.",
      actions: [
        { id: "logs", label: "MCP logs" },
        { id: "back", label: "Back" },
      ],
      onAction: (action) =>
        action === "logs" ? this.logs(snapshot) : this.open(),
    });
  }
  private logs(snapshot: ConnectionSnapshot): void {
    try {
      this.overlays.openText({
        title: "MCP log",
        body: `${snapshot.mcpLogPath}\n\n${readConnectionLog(snapshot.mcpLogPath, snapshot.redact)}`,
        actions: [{ id: "back", label: "Back" }],
        onAction: () => this.open(),
      });
    } catch (error) {
      this.error(error);
    }
  }
  private error(error: unknown): void {
    this.overlays.openText({
      title: "Connections error",
      body: error instanceof Error ? error.message : String(error),
      actions: [{ id: "back", label: "Back" }],
      onAction: () => this.open(),
    });
  }
}
