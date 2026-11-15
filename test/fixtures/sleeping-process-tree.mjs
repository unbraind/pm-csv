import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../../scripts/acceptance-process.ts';

// A tiny npm-like child: leave inherited pipes open and keep its grandchild alive.
if (process.argv[2] === 'supervisor') {
  await runCommand(process.execPath, [fileURLToPath(import.meta.url), process.argv[3]], { cwd: process.cwd(), timeoutMs: 60_000 });
} else if (process.argv[2] !== 'grandchild') {
  const grandchild = spawn(process.execPath, [fileURLToPath(import.meta.url), 'grandchild'], { stdio: 'inherit' });
  writeFileSync(process.argv[2], JSON.stringify([process.pid, grandchild.pid]));
}
process.on('SIGTERM', () => {});
setInterval(() => {}, 1_000);
