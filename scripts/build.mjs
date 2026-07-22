import { spawn } from "node:child_process";

function runBun(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: "inherit" });

    child.on("error", (error) => {
      console.error(`[build] failed to start bun ${args.join(" ")}:`, error);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        console.error(`[build] bun ${args.join(" ")} terminated by ${signal}`);
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

const buildCommands = [
  ["x", "svelte-check", "--tsconfig", "./tsconfig.json"],
  ["x", "tsc", "--noEmit"],
  ["x", "vite", "build"],
];

let buildStatus = 0;
for (const command of buildCommands) {
  buildStatus = await runBun(command);
  if (buildStatus !== 0) break;
}

// Cleanup must run even when a build command fails so release-profile WASM is
// never reused by later development or test commands.
const cleanupStatus = await runBun(["run", "clean:wasm"]);
process.exitCode = buildStatus || cleanupStatus;
