import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpExtension } from "@earendil-works/pi-coding-agent";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { PiHost } from "../src/host/controller.ts";
import {
  executeConnectionAction,
  readConnectionLog,
  readConnections,
  redactConnectionText,
} from "../src/core/connections.ts";
const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
const {
  InMemoryAuthStorageBackend,
}: typeof import("../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js") =
  await import(new URL("./core/auth-storage.js", sdk).href);
const {
  McpOAuthCredentialStore,
}: typeof import("../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/oauth.js") =
  await import(new URL("./extensions/mcp/oauth.js", sdk).href);
async function fixture(mcp = false, fail = false) {
  const directory = mkdtempSync(join(tmpdir(), "pi-connections-")),
    agent = join(directory, "agent");
  mkdirSync(agent);
  let transports = 0,
    disconnect: () => Promise<void> = async () => {};
  const factory = createMcpExtension({
    credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
    logPath: join(agent, "mcp.log"),
    loadConfig: () => ({
      servers: [
        {
          name: "fixture",
          config: { command: "unused", exposure: "direct" },
          source: "fixture",
        },
      ],
      errors: [],
    }),
    createTransport: () => {
      transports++;
      if (fail) throw new Error("fixture connect failed");
      const pair = createInMemoryTransportPair();
      disconnect = () => pair.server.close();
      void pair.server.start();
      pair.server.onMessage((message) => {
        if (!("method" in message) || !("id" in message)) return;
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: (message.params as { protocolVersion: string })
                  .protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "offline-fixture", version: "1" },
              }
            : message.method === "tools/list"
              ? { tools: [] }
              : {};
        void pair.server.send({ jsonrpc: "2.0", id: message.id!, result });
      });
      return pair.client;
    },
  });
  const host = await PiHost.create({
    cwd: directory,
    agentDir: agent,
    clean: true,
    extensionFactories: mcp ? [factory] : [],
  });
  return {
    directory,
    agent,
    host,
    transports: () => transports,
    disconnect: () => disconnect(),
    cleanup: async () => {
      await host.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
test("clean configuration is honest and tool names do not imply a connection", async () => {
  const f = await fixture();
  try {
    const result = await readConnections(f.host);
    expect(result.mcp).toEqual([]);
    expect(result.mcpAvailable).toBe(false);
    expect(result.lsp.state).toBe("unknown");
    expect(result.lspAvailable).toBe(false);
    expect(result.diagnostics).toEqual([]);
  } finally {
    await f.cleanup();
  }
});
test("verified config reader honors selected agent directory and project trust without exposing credentials", async () => {
  const f = await fixture();
  try {
    writeFileSync(
      join(f.agent, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          docs: {
            url: "https://example.invalid/mcp",
            headers: { Authorization: "Bearer TOP-SECRET" },
          },
          disabled: { command: "unused", enabled: false },
        },
      }),
    );
    mkdirSync(join(f.directory, ".pi"));
    writeFileSync(
      join(f.directory, ".pi/mcp.json"),
      JSON.stringify({ mcpServers: { untrusted: { command: "never-run" } } }),
    );
    f.host.runtime.services.settingsManager.setProjectTrusted(false);
    let result = await readConnections(f.host);
    expect(result.mcp.map((row) => row.name)).toEqual(["docs", "disabled"]);
    expect(result.mcp[0]!.state).toBe("configured");
    expect(result.mcp[1]!.state).toBe("disabled");
    expect(JSON.stringify(result)).not.toContain("TOP-SECRET");
    f.host.runtime.services.settingsManager.setProjectTrusted(true);
    result = await readConnections(f.host);
    expect(result.mcp.some((row) => row.name === "untrusted")).toBe(true);
  } finally {
    await f.cleanup();
  }
});
test("actual MCP public completion reports connected/disconnected and reconnects using native command", async () => {
  const f = await fixture(true);
  try {
    let result = await readConnections(f.host);
    for (let i = 0; i < 50 && result.mcp[0]?.state !== "connected"; i++) {
      await Bun.sleep(10);
      result = await readConnections(f.host);
    }
    expect(result.mcpAvailable).toBe(true);
    expect(result.mcp.find((row) => row.name === "fixture")?.state).toBe(
      "connected",
    );
    expect(result.mcp.find((row) => row.name === "fixture")?.retryName).toBe(
      "fixture",
    );
    expect(f.transports()).toBe(1);
    await f.disconnect();
    expect((await readConnections(f.host)).mcp[0]!.state).toBe("disconnected");
    await executeConnectionAction(f.host, {
      kind: "mcp-retry",
      name: "fixture",
    });
    expect(f.transports()).toBe(2);
    expect((await readConnections(f.host)).mcp[0]!.state).toBe("connected");
  } finally {
    await f.cleanup();
  }
});
test("actual LSP footer schema distinguishes active clients, configured idle and failed initialization", async () => {
  const f = await fixture();
  try {
    f.host.bridge.statuses.set(
      "lsp",
      "\x1b[35mLSP: 2/7 servers, 1 warning(s)\x1b[0m",
    );
    let lsp = (await readConnections(f.host)).lsp;
    expect(lsp.state).toBe("connected");
    expect(lsp.active).toBe(2);
    expect(lsp.total).toBe(7);
    f.host.bridge.statuses.set("lsp", "LSP: 0/7 servers");
    expect((await readConnections(f.host)).lsp.state).toBe("configured");
    f.host.bridge.statuses.set("lsp", "LSP: failed");
    expect((await readConnections(f.host)).lsp.state).toBe("error");
  } finally {
    await f.cleanup();
  }
});
test("logs are bounded, secret fields and terminal controls are redacted, missing logs are explicit", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-connection-logs-")),
    file = join(directory, "mcp.log");
  try {
    expect(readConnectionLog(file)).toContain("No MCP log");
    writeFileSync(
      file,
      "old\n".repeat(20000) +
        'Authorization: Bearer SECRET\n{"access_token":"SECRET","password":"PASS"}\nhttps://name:password@example.invalid/?token=SECRET\n\x1b[31mfailure\x1b[0m\n',
    );
    const text = readConnectionLog(file);
    expect(text).toContain("Last 64 KiB");
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("PASS");
    expect(text).not.toContain("name:password");
    expect(text).not.toContain("\x1b");
    expect(redactConnectionText("sensitive-value", ["sensitive-value"])).toBe(
      "[redacted]",
    );
    expect(
      redactConnectionText('{"Authorization":"Bearer EXPOSED"}'),
    ).not.toContain("EXPOSED");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("unloaded native commands cannot accidentally start a model turn", async () => {
  const f = await fixture();
  try {
    const before = JSON.stringify(f.host.entries);
    await expect(
      executeConnectionAction(f.host, { kind: "mcp-manager" }),
    ).rejects.toThrow("not loaded");
    expect(JSON.stringify(f.host.entries)).toBe(before);
  } finally {
    await f.cleanup();
  }
});

test("failed actual MCP startup is exposed as error with native diagnostics", async () => {
  const f = await fixture(true, true);
  try {
    let snapshot = await readConnections(f.host);
    for (let i = 0; i < 50 && snapshot.mcp[0]?.state !== "error"; i++) {
      await Bun.sleep(10);
      snapshot = await readConnections(f.host);
    }
    expect(snapshot.mcp[0]?.state).toBe("error");
    expect(snapshot.mcp[0]?.summary).toContain("fixture connect failed");
    expect(
      snapshot.diagnostics.some((message) =>
        message.includes("MCP servers need attention"),
      ),
    ).toBe(true);
  } finally {
    await f.cleanup();
  }
});
