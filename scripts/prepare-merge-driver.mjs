import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, delimiter } from 'node:path';

// Wire pm-cli's field-aware Git merge drivers into this clone's local Git config on
// install/clone, but only when the `pm` CLI is actually available. Implemented in Node
// (not a POSIX `if ...; then ...; fi` shell guard) so it runs identically on POSIX shells
// and Windows cmd.exe (npm's default script shell) with no shell-operator parsing.

/**
 * Is the `pm` executable resolvable on PATH? Resolved by inspecting PATH directly
 * (never by executing `pm`), so a present-but-broken CLI is NOT mistaken for "absent":
 * absence => silent skip, presence => run fail-loud below. npm prepends
 * `node_modules/.bin` to PATH for lifecycle scripts, so a devDep-installed pm is found.
 */
function pmOnPath() {
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
  // Windows resolves executables via PATHEXT (.CMD/.EXE/...); every other platform uses
  // the bare name. The filesystem is case-insensitive on Windows, so one case suffices.
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim())
      : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      if (existsSync(join(dir, `pm${ext}`))) return true;
    }
  }
  return false;
}

if (!pmOnPath()) {
  // `pm` is not installed (e.g. a production / `--omit=dev` install, or a consumer
  // machine without the CLI) — skip merge-driver wiring silently, don't fail install.
  process.exit(0);
}

// `pm` IS present: wire the drivers. If this genuinely fails (e.g. a broken or
// incompatible CLI), surface it fail-loud (non-zero exit) rather than swallowing it.
execSync('pm merge install', { stdio: 'inherit' });
