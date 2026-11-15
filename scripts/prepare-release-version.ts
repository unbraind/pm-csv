/** Stamp the package-owned runtime version after the shared release metadata update. */
import { readFileSync, writeFileSync } from 'node:fs';

import { resolve } from 'node:path';
import { isMainInvocation } from './main-invocation.ts';

/** Validate release metadata and replace exactly one runtime literal in the given package root. */
export function prepareReleaseVersion(root: string): void {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { name: string; version: string };
  const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8')) as { version: string };
  if (pkg.name !== "pm-csv" || !/^\d+\.\d+\.\d+(?:-\d+)?$/u.test(pkg.version) || manifest.version !== pkg.version) {
    throw new Error('Release package and manifest versions must agree before runtime preparation');
  }
  const file = resolve(root, "index.ts");
  const source = readFileSync(file, 'utf8');
  const target = /(export default \{\s*name:\s*"pm-csv",\s*version:\s*)["'][^"']+["']/gu;
  if ([...source.matchAll(target)].length !== 1) throw new Error('Expected exactly one package runtime version target');
  writeFileSync(file, source.replace(target, (_match: string, prefix: string) => prefix + JSON.stringify(pkg.version)));
}

if (isMainInvocation(process.argv, import.meta.url)) prepareReleaseVersion(process.cwd());
