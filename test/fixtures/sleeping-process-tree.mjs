import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runCommand, scaledBudget } from '../../scripts/acceptance-process.ts';

// An outer runner and nested supervisor each own a separate active process group.
if (process.argv[2] === 'outer') {
  await runCommand(process.execPath, [fileURLToPath(import.meta.url), 'supervisor', process.argv[3]], {
    cwd: process.cwd(), timeoutMs: scaledBudget(60_000), terminationGraceMs: 1_000,
  });
} else if (process.argv[2] === 'supervisor') {
  writeFileSync(`${process.argv[3]}.supervisor`, String(process.pid));
  await runCommand(process.execPath, [fileURLToPath(import.meta.url), process.argv[3]], { cwd: process.cwd(), timeoutMs: scaledBudget(60_000) });
} else {
  // A tiny npm-like child: leave inherited pipes open and keep its grandchild alive.
  if (process.argv[2] !== 'grandchild') {
    const grandchild = spawn(process.execPath, [fileURLToPath(import.meta.url), 'grandchild'], { stdio: 'inherit' });
    writeFileSync(process.argv[2], JSON.stringify([process.pid, grandchild.pid]));
  }
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1_000);
}
