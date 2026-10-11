import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

// Node initializes the parent test's coverage collector before loading this
// module. Keep that collector, but exclude fixture CLI subprocesses: intentional
// kills can leave empty coverage files, and those CLI files are outside this
// package's configured source set.
delete process.env.NODE_V8_COVERAGE;

// Negative IO and process-termination fixtures must never report to production
// observability or inherit a developer's global tracker settings. Import this
// before the host SDK so both the test process and every child inherit isolation.
const globalRoot = mkdtempSync(join(tmpdir(), "pm-csv-test-global-"));
process.env.PM_GLOBAL_PATH = globalRoot;
process.env.PM_SENTRY_DISABLED = "1";
process.env.PM_TELEMETRY_DISABLED = "1";
process.env.PM_TELEMETRY_OTEL_DISABLED = "1";

after(() => rmSync(globalRoot, { recursive: true, force: true }));
