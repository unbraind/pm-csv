/** Exercise the released shared stamper, caller hook and actual build in an isolated package. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { stampExtensionVersion } from 'pm-ops/daily-release';
import { prepareReleaseVersion } from '../scripts/prepare-release-version.ts';

const root = resolve('.');
const sourceFile = 'index.ts';

/** Copy the build inputs without dependencies or generated output; cleanup also runs after failures. */
function withPackage(run: (scratch: string) => void): void {
  const scratch = mkdtempSync(join(tmpdir(), 'release-runtime-'));
  try {
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0');
    for (const file of [...files, 'scripts/prepare-release-version.ts']) {
      if (!/\.(?:ts|json)$/u.test(file) || /^(?:\.agents|test|dist|coverage)\//u.test(file)) continue;
      mkdirSync(dirname(join(scratch, file)), { recursive: true });
      copyFileSync(join(root, file), join(scratch, file));
    }
    symlinkSync(resolve('node_modules'), join(scratch, 'node_modules'), 'junction');
    run(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Update one metadata file as the workflow does before invoking the caller hook. */
function metadata(scratch: string, file: string, changes: Record<string, string>): void {
  const path = join(scratch, file);
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), ...changes }, null, 2) + '\n');
}

test('scratch release build agrees across package, manifest and built runtime', () => {
  withPackage(scratch => {
    const version = '2099.1.2-3';
    metadata(scratch, 'package.json', { version });
    metadata(scratch, 'manifest.json', { version });
    for (const file of ['index.ts']) {
      const path = join(scratch, file);
      writeFileSync(path, stampExtensionVersion(readFileSync(path, 'utf8'), version));
    }
    const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8')) as { jobs: { release: { with: Record<string, string> } } };
    const hook = workflow.jobs.release.with['prepare-script'];
    // This mirrors the optional hook: removing the caller input must expose the stale built version.
    if (hook) execFileSync('npm', ['run', hook], { cwd: scratch, encoding: 'utf8' });
    const once = readFileSync(join(scratch, sourceFile), 'utf8');
    if (hook) execFileSync('npm', ['run', hook], { cwd: scratch, encoding: 'utf8' });
    assert.equal(readFileSync(join(scratch, sourceFile), 'utf8'), once, 'preparation is idempotent');
    execFileSync('npm', ['run', 'build'], { cwd: scratch, encoding: 'utf8', timeout: 120_000 });
    const actual = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import extension from './dist/index.js';
      console.log(extension.version);
    `], { cwd: scratch, encoding: 'utf8', timeout: 30_000 });
    assert.equal(actual.trim(), version, 'built runtime version must advance with release metadata');
    for (const file of ['package.json', 'manifest.json']) {
      assert.equal(JSON.parse(readFileSync(join(scratch, file), 'utf8')).version, version, file);
    }
  });
});

test('preparation refuses inconsistent metadata and missing or ambiguous targets without source edits', () => {
  withPackage(scratch => {
    const path = join(scratch, sourceFile);
    const original = readFileSync(path, 'utf8');
    metadata(scratch, 'manifest.json', { version: '0.0.0' });
    assert.throws(() => prepareReleaseVersion(scratch));
    assert.equal(readFileSync(path, 'utf8'), original);
    const version = JSON.parse(readFileSync(join(scratch, 'package.json'), 'utf8')).version as string;
    metadata(scratch, 'manifest.json', { version });
    prepareReleaseVersion(scratch);
    assert.equal(readFileSync(path, 'utf8'), original);
    for (const bad of ['', original + '\n' + original]) {
      writeFileSync(path, bad);
      assert.throws(() => prepareReleaseVersion(scratch));
      assert.equal(readFileSync(path, 'utf8'), bad);
    }
    writeFileSync(path, original);
    metadata(scratch, 'package.json', { name: 'another-package' });
    assert.throws(() => prepareReleaseVersion(scratch));
    metadata(scratch, 'package.json', { name: 'pm-csv', version: 'invalid' });
    assert.throws(() => prepareReleaseVersion(scratch));
    assert.equal(readFileSync(path, 'utf8'), original);
  });
});
