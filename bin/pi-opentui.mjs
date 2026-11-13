#!/usr/bin/env node
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const require=createRequire(import.meta.url);
const runtime=require.resolve('bun/bin/bun.exe');
const child=spawn(runtime,[fileURLToPath(new URL('../src/cli.ts',import.meta.url)),...process.argv.slice(2)],{stdio:'inherit',env:process.env});
const signalHandlers=new Map(['SIGTERM','SIGHUP','SIGINT'].map(signal=>[signal,()=>child.kill(signal)]));
for(const [signal,handler] of signalHandlers)process.on(signal,handler);
const detachSignals=()=>{for(const [signal,handler] of signalHandlers)process.off(signal,handler);};
child.on('error',error=>{detachSignals();console.error(`pi-opentui: ${error.message}`);process.exitCode=1;});
child.on('exit',(code,signal)=>{detachSignals();if(signal)process.kill(process.pid,signal);else process.exitCode=code??1;});
