import assert from "node:assert/strict";

/** Package metadata needed to verify one reproducible toolchain install. */
export interface ToolchainMetadata {
  devDependencies?: Record<string, string>;
  packages?: Record<string, { version?: string; devDependencies?: Record<string, string> }>;
}

/** Reject ranges and inconsistent root lock, resolved lock or installed toolchain versions. */
export function assertToolchainPins(manifest: ToolchainMetadata, lock: ToolchainMetadata, installed: Record<string, string>): void {
  for (const name of ["@unbrained/pm-cli", "pm-ops", "pm-changelog"]) {
    const pin = manifest.devDependencies?.[name];
    assert.ok(pin, `${name} needs a development pin`);
    assert.match(pin, /^\d+\.\d+\.\d+$/, `${name} needs an exact development pin`);
    assert.equal(lock.packages?.[""]?.devDependencies?.[name], pin, `${name} root lock declaration must match`);
    assert.equal(lock.packages?.[`node_modules/${name}`]?.version, pin, `${name} resolved lock version must match`);
    assert.equal(installed[name], pin, `${name} installed version must match`);
  }
}
