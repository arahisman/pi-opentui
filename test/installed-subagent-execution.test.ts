import { expect, test } from "bun:test";
import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installed = join(homedir(), ".pi/agent/local-packages/subagents");

for (const mode of ["foreground", "background"] as const)
  test.skipIf(!existsSync(join(installed, "package.json")))(
    `installed subagent executes ${mode} offline child and renders its result`,
    async () => {
      const node = process.env.PI_OPENTUI_TEST_NODE ?? Bun.which("node");
      if (!node)
        throw new Error(
          "Set PI_OPENTUI_TEST_NODE to supported Node.js >=26.4.0",
        );
      const version = new TextDecoder()
          .decode(Bun.spawnSync([node, "--version"]).stdout)
          .trim(),
        parts = version.slice(1).split(".").map(Number);
      if (parts[0]! < 26 || (parts[0] === 26 && parts[1]! < 4))
        throw new Error(
          `Installed subagent execution requires supported Node.js; selected ${version}`,
        );
      const directory = mkdtempSync(join(tmpdir(), "pi-subagent-execution-")),
        home = join(directory, "home"),
        agent = join(home, ".pi/agent"),
        cwd = join(directory, "project"),
        temporary = join(directory, "tmp");
      for (const path of [
        agent,
        cwd,
        temporary,
        join(agent, "extensions"),
        join(agent, "agents"),
        join(agent, "extensions/subagent"),
      ])
        mkdirSync(path, { recursive: true });
      const provider = join(agent, "extensions/offline-provider.ts"),
        ai = Bun.resolveSync("@earendil-works/pi-ai", project);
      writeFileSync(
        provider,
        `import {appendFileSync,existsSync,readFileSync} from "node:fs";\nimport net from "node:net";\nimport http from "node:http";\nimport https from "node:https";\nimport {syncBuiltinESMExports} from "node:module";\nimport {createAssistantMessageEventStream} from ${JSON.stringify(ai)};\nconst audit=(event)=>appendFileSync(${JSON.stringify(join(directory, "provider-events.jsonl"))},JSON.stringify(event)+"\\n");\nconst deny=(...args)=>{audit({type:"network",pid:process.pid});throw new Error("Offline worker prohibits networking");};globalThis.fetch=Object.assign(deny,{preconnect:deny});http.request=deny;http.get=deny;https.request=deny;https.get=deny;const originalConnect=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...args){const value=Array.isArray(args[0]) ? args[0][0] : args[0];const socket=typeof value === "string" ? value : value?.path;if(typeof socket === "string" && socket.startsWith(${JSON.stringify(directory)}))return originalConnect.apply(this,args);return deny();};syncBuiltinESMExports();\nexport default function(pi){\n pi.on("session_start",(_event,ctx)=>audit({type:"start",pid:process.pid,nodeVersion:process.versions.node,sessionId:ctx.sessionManager.getSessionId(),sessionFile:ctx.sessionManager.getSessionFile() ?? null,mode:ctx.mode,hasUI:ctx.hasUI}));\n pi.on("session_shutdown",(_event,ctx)=>audit({type:"stop",sessionId:ctx.sessionManager.getSessionId()}));\n pi.registerProvider("offline-subagent-fixture",{name:"Offline subagent fixture",api:"openai-completions",apiKey:"offline-fixture",baseUrl:"http://127.0.0.1:9",models:[{id:"parent",name:"Offline parent",reasoning:false,input:["text"],contextWindow:32000,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}},{id:"child",name:"Offline child",reasoning:false,input:["text"],contextWindow:32000,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],streamSimple:(model,context)=>{\n  audit({type:"request",model:model.id,pid:process.pid});const stream=createAssistantMessageEventStream();const emit=()=>{const user=context.messages.filter(message=>message.role === "user").at(-1);const inspect=model.id === "parent" && JSON.stringify(user?.content).includes("Inspect completed background run") && !context.messages.some(message=>message.role === "toolResult" && message.toolCallId === "offline-background-transcript");const tool=inspect || (model.id === "parent" && !context.messages.some(message=>message.role === "toolResult" && message.toolName === "subagent"));const output=model.id === "child" ? "OFFLINE_CHILD_RESULT: deterministic delegate finished." : "Parent confirmed native subagent completion.";const message={role:"assistant",api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),content:tool ? [{type:"toolCall",id:inspect ? "offline-background-transcript" : "offline-delegate",name:"subagent",arguments:inspect ? {action:"status",id:JSON.parse(readFileSync(${JSON.stringify(join(directory, "owned-run.json"))},"utf8")).runId,options:{view:"transcript",lines:80}} : {agent:"offline-fixture",task:"Return the deterministic offline result.",async:${mode === "background"},worktree:false,options:{context:"fresh",skill:false,acceptance:false,chatProgress:"off",timeoutMs:15000}}}] : [{type:"text",text:""}],stopReason:tool ? "toolUse" : "stop",usage:{input:13,output:7,cacheRead:3,cacheWrite:0,totalTokens:23,cost:{input:0.004,output:0.006,cacheRead:0,cacheWrite:0,total:0.01}}};stream.push({type:"start",partial:message});if(!tool){stream.push({type:"text_start",contentIndex:0,partial:message});message.content[0].text=output;stream.push({type:"text_delta",contentIndex:0,delta:output,partial:message});stream.push({type:"text_end",contentIndex:0,content:output,partial:message});}stream.push({type:"done",reason:message.stopReason,message});stream.end();};if(model.id === "child" && ${mode === "background"}){const timer=setInterval(()=>{if(existsSync(${JSON.stringify(join(directory, "release-child"))})){clearInterval(timer);emit();}},20);}else queueMicrotask(emit);return stream;}});\n}\n`,
      );
      writeFileSync(
        join(agent, "settings.json"),
        JSON.stringify({
          packages: [installed],
          extensions: [provider],
          defaultProvider: "offline-subagent-fixture",
          defaultModel: "parent",
        }),
      );
      writeFileSync(
        join(agent, "extensions/subagent/config.json"),
        JSON.stringify({
          asyncByDefault: false,
          defaultSubagentContext: "fresh",
        }),
      );
      writeFileSync(
        join(agent, "agents/offline-fixture.md"),
        `---\nname: offline-fixture\ndescription: Deterministic offline execution fixture\nmodel: offline-subagent-fixture/child\nthinking: off\ntools: read\nextensions: ${JSON.stringify(provider)}\ninheritProjectContext: false\ninheritGlobalContext: false\ninheritSkills: false\n---\nReturn the exact offline result. Do not invoke tools.\n`,
      );
      writeFileSync(
        join(agent, "mcp.json"),
        JSON.stringify({ mcpServers: {} }),
      );
      writeFileSync(
        join(agent, "WATCHDOG.yml"),
        "main: false\nsubagents: false\n",
      );
      writeFileSync(
        join(cwd, "WATCHDOG.yml"),
        "main: false\nsubagents: false\n",
      );
      const fixture = fileURLToPath(
        new URL("./fixtures/installed-subagent-execution.ts", import.meta.url),
      );
      let completed = false;
      try {
        const result = await new Promise<{ stdout: string; stderr: string }>(
          (complete, reject) =>
            execFile(
              process.execPath,
              [fixture, directory, mode],
              {
                cwd,
                timeout: 45000,
                maxBuffer: 2 * 1024 * 1024,
                env: {
                  PATH: `${dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`,
                  HOME: home,
                  PI_CODING_AGENT_DIR: agent,
                  TMPDIR: temporary,
                  XDG_CONFIG_HOME: join(home, ".config"),
                  XDG_CACHE_HOME: join(home, ".cache"),
                  XDG_DATA_HOME: join(home, ".local/share"),
                  TERM: "dumb",
                  TERM_PROGRAM: "rex",
                  NO_COLOR: "1",
                  PI_OFFLINE: "1",
                  PI_TELEMETRY: "0",
                  PI_OPENTUI_HOST: "1",
                  PI_ADVISOR_SUBAGENTS: "0",
                  PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: join(
                    project,
                    "node_modules/@earendil-works/pi-coding-agent",
                  ),
                },
              },
              (error, stdout, stderr) =>
                error
                  ? reject(
                      new Error(
                        `Installed subagent execution failed: ${error.message}\n${stdout}\n${stderr}`,
                      ),
                    )
                  : complete({ stdout, stderr }),
            ),
        );
        const marker = result.stdout
          .split("\n")
          .find((line) => line.startsWith("INSTALLED_SUBAGENT_RESULT "));
        expect(marker).toBeDefined();
        const report = JSON.parse(
          marker!.slice("INSTALLED_SUBAGENT_RESULT ".length),
        );
        if (mode === "foreground")
          expect(report.requests).toEqual(["parent", "child", "parent"]);
        else {
          expect(
            report.requests.filter((value: string) => value === "child"),
          ).toHaveLength(1);
          expect(report.backgroundState).toBe("complete");
          expect(report.nativeStatus).toContain("Process terminal: observed");
          expect(report.runnerStopped).toBe(true);
          expect(report.editorUsableWhileRunning).toBe(true);
          expect(report.detachedPid).not.toBe(report.parentPid);
          expect(report.childNodeVersion).toBe(version.slice(1));
        }
        expect(report.childExit).toBe(0);
        expect(report.childUsage.input).toBe(13);
        expect(report.visibleNativeResult).toBe(true);
        expect(report.networkAttempts).toEqual([]);
        expect(report.childMode).toBe("print");
        expect(report.childHasUI).toBe(false);
        expect(report.separateSession).toBe(true);
        expect(report.childStopped).toBe(true);
        expect(report.presentationOwners).toEqual([]);
        expect(report.hostErrors).toEqual([]);
        expect(report.credentialStorageEmpty).toBe(true);
        expect(result.stdout).not.toContain("\x1b[?1049h");
        completed = true;
        const output = join(project, ".artifacts/verification");
        mkdirSync(output, { recursive: true });
        writeFileSync(
          join(output, `installed-subagent-execution-${mode}.json`),
          JSON.stringify(
            {
              ...report,
              installedPackage: JSON.parse(
                readFileSync(join(installed, "package.json"), "utf8"),
              ).version,
              stderr: result.stderr,
            },
            null,
            2,
          ),
        );
      } finally {
        try {
          const ownership = join(directory, "owned-run.json");
          if (!completed && existsSync(ownership)) {
            const owned = JSON.parse(readFileSync(ownership, "utf8"));
            let command = "";
            try {
              command = execFileSync(
                "/bin/ps",
                ["-p", String(owned.pid), "-o", "command="],
                { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
              );
            } catch (error) {
              if ((error as { status?: number }).status !== 1) throw error;
            }
            if (command.includes(directory)) {
              try {
                process.kill(owned.pid, "SIGKILL");
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ESRCH")
                  throw error;
              }
            }
          }
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
    },
    55000,
  );
