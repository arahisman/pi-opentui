import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import tempfile
import termios
import time
import shutil

options = json.loads(sys.argv[1])
project = options["project"]
node = options["node"]
mode = options["mode"]
workspace = tempfile.mkdtemp(prefix="pi-opentui-pty-")
master = None
pid = None
output = bytearray()
audit_path = os.path.join(workspace, "audit.jsonl")


def events():
    if not os.path.exists(audit_path):
        return []
    with open(audit_path) as source:
        return [json.loads(line) for line in source if line.strip()]


def plain():
    value = output.decode("utf-8", "replace")
    value = re.sub(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)", "", value)
    return re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", value)


def pump(duration=0.1):
    deadline = time.monotonic() + duration
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], min(0.05, max(0, deadline-time.monotonic())))
        if not ready:
            continue
        try:
            data = os.read(master, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                return
            raise
        if not data:
            return
        output.extend(data)
        for query, response in [(b"\x1b[6n", b"\x1b[1;1R"), (b"\x1b[?u", b"\x1b[?0u"), (b"\x1b[c", b"\x1b[?1;2c"), (b"\x1b[>c", b"\x1b[>0;0;0c")]:
            if query in data:
                os.write(master, response)


def wait_for(predicate, description, timeout=18):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        pump()
        if predicate():
            return
    raise RuntimeError("Timed out waiting for " + description + "\n" + plain()[-7000:])


def resize(cols, rows):
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    pump(0.2)


try:
    agent = os.path.join(workspace, "agent")
    os.mkdir(agent)
    audit = os.path.join(workspace, "audit.ts")
    with open(audit, "w") as target:
        target.write('''import {appendFileSync} from "node:fs";
export default function(pi) {
 const record=(type,ctx,event)=>appendFileSync(process.env.PTY_AUDIT,JSON.stringify({type,pid:process.pid,host:process.env.PI_OPENTUI_HOST === "1",session:ctx.sessionManager.getSessionFile() ?? null,reason:event.reason})+"\\n");
 pi.on("session_start",(event,ctx)=>{record("start",ctx,event);if(process.env.PTY_FAIL_CHILD === "1" && process.env.PI_OPENTUI_HOST === "1")setTimeout(()=>process.exit(17),150);});
 pi.on("session_shutdown",(event,ctx)=>record("stop",ctx,event));
 pi.on("before_agent_start",(event,ctx)=>record("model-request",ctx,event));
}
''')
    with open(os.path.join(agent, "models.json"), "w") as target:
        json.dump({"providers":{"pty-offline":{"baseUrl":"http://127.0.0.1:9/v1","api":"openai-completions","apiKey":"offline-fixture","models":[{"id":"fixture","name":"PTY fixture","contextWindow":32000,"maxTokens":1024}]}}}, target)
    with open(os.path.join(agent, "settings.json"), "w") as target:
        json.dump({"defaultProvider":"pty-offline","defaultModel":"fixture","quietStartup":True,"extensions":[audit]}, target)
    session = os.path.join(workspace, "original.jsonl")
    with open(session, "w") as target:
        target.write(json.dumps({"type":"session","version":3,"id":"original-session","timestamp":"2026-11-13T00:00:00Z","cwd":workspace})+"\n")
        target.write(json.dumps({"type":"message","id":"fixture-user","parentId":None,"timestamp":"2026-11-13T00:00:00Z","message":{"role":"user","content":"Offline terminal fixture; do not send a model request.","timestamp":1}})+"\n")
    environment = {"HOME":workspace,"PATH":os.path.dirname(node)+":/usr/bin:/bin:/usr/sbin:/sbin","TERM":"xterm-256color","LANG":"en_US.UTF-8","PI_CODING_AGENT_DIR":agent,"PI_OFFLINE":"1","PI_TELEMETRY":"0","PTY_AUDIT":audit_path}
    if mode == "native-failure":
        environment["PTY_FAIL_CHILD"] = "1"
    if mode.startswith("native"):
        command=[node,options.get("sdkCli",os.path.join(project,"node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js")),"--offline","--approve","--no-extensions","--no-skills","--no-context-files","--no-prompt-templates","--no-themes","--no-mcp","--no-tools","-e",os.path.join(project,"src/extension.ts"),"-e",audit,"--session",session]
    else:
        command=[node,os.path.join(project,"bin/pi-opentui.mjs"),"--cwd",workspace,"--agent-dir",agent,"--session",session]
    if mode == "startup-failure":
        command.append("--unknown-terminal-test-option")
    pid, master = pty.fork()
    if pid == 0:
        os.chdir(workspace)
        os.execve(node, command, environment)
    initial = termios.tcgetattr(master)
    resize(110,34)
    if mode == "startup-failure":
        pump(3)
    elif mode.startswith("native"):
        wait_for(lambda: any(row["type"] == "start" and not row["host"] for row in events()), "native Pi startup")
        pump(0.6)
        os.write(master,b"/opentui\r")
        wait_for(lambda: any(row["type"] == "start" and row["host"] for row in events()), "actual OpenTUI child startup",25)
        if mode == "native-new":
            pump(0.4)
            os.write(master,b"/new\r")
            wait_for(lambda: len([row for row in events() if row["type"] == "start" and row["host"]]) >= 2, "OpenTUI switching its session")
        returned_session = [row for row in events() if row["type"] == "start" and row["host"]][-1]["session"]
        resize(48,20)
        resize(120,36)
        if mode != "native-failure":
            pump(0.5)
            os.write(master,b"\x04")
        wait_for(lambda: any(row["type"] == "start" and not row["host"] and row["session"] == returned_session and row.get("reason") == "resume" for row in events()), "native Pi reopening returned session",25)
        child_pid = next(row["pid"] for row in events() if row["type"] == "start" and row["host"])
        try:
            os.kill(child_pid,0)
            child_alive_on_return = True
        except ProcessLookupError:
            child_alive_on_return = False
        pump(0.5)
        os.write(master,b"\x04")
    else:
        wait_for(lambda: "ctrl+p" in plain() or "commands" in plain(), "actual OpenTUI screen",25)
        resize(20,8)
        resize(140,42)
        if mode == "standalone-signal":
            os.kill(pid,signal.SIGTERM)
        else:
            os.write(master,b"\x04")
    deadline=time.monotonic()+15
    status=None
    while time.monotonic()<deadline:
        pump()
        result,status_value=os.waitpid(pid,os.WNOHANG)
        if result:
            status=os.waitstatus_to_exitcode(status_value)
            break
    if status is None:
        raise RuntimeError("Terminal process did not exit\n"+plain()[-7000:])
    final=termios.tcgetattr(master)
    flags=termios.ECHO|termios.ICANON|termios.ISIG
    result={"mode":mode,"exitCode":status,"terminalRestored":initial == final,"terminalFlagsRestored":initial[3]&flags == final[3]&flags,"initialFlags":initial[3]&flags,"finalFlags":final[3]&flags,"alternateEntered":b"\x1b[?1049h" in output,"alternateExited":b"\x1b[?1049l" in output,"events":events(),"outputTail":plain()[-2500:],"bytes":len(output),"originalSession":session,"returnedSession":returned_session if mode.startswith("native") else None,"childAliveOnReturn":child_alive_on_return if mode.startswith("native") else None}
    print(json.dumps(result))
except Exception as error:
    print(json.dumps({"mode":mode,"error":str(error),"events":events(),"outputTail":plain()[-7000:]}))
    sys.exit(1)
finally:
    if pid:
        try:
            os.killpg(pid,signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(pid,os.WNOHANG)
        except ChildProcessError:
            pass
    if master is not None:
        os.close(master)
    shutil.rmtree(workspace)
