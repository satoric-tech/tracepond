import assert from "node:assert/strict";
import test from "node:test";
import { parseDurationMs, resolveMemoryConfig } from "../src/memory/duckdb.ts";

test("parseDurationMs uses standard duration strings", () => {
  assert.equal(parseDurationMs(undefined), undefined);
  assert.equal(parseDurationMs("0"), 0);
  assert.equal(parseDurationMs("30s"), 30_000);
  assert.equal(parseDurationMs("5m"), 300_000);
  assert.equal(parseDurationMs("1h"), 3_600_000);
  assert.throws(() => parseDurationMs("soon"), /Invalid refresh interval/);
});

test("resolveMemoryConfig reads env and normalizes paths", () => {
  const previousRefreshInterval = process.env.TRACEPOND_REFRESH_INTERVAL;
  const previousTracepondHome = process.env.TRACEPOND_HOME;
  const previousOpenCodeHome = process.env.TRACEPOND_OPENCODE_HOME;
  process.env.TRACEPOND_REFRESH_INTERVAL = "2m";
  process.env.TRACEPOND_HOME = ".tracepond-test";
  process.env.TRACEPOND_OPENCODE_HOME = ".opencode-test";

  try {
    const config = resolveMemoryConfig({ cwd: "." });
    assert.equal(config.refreshIntervalMs, 120_000);
    assert.ok(config.cwd.startsWith("/"));
    assert.ok(config.tracepondHome.endsWith(".tracepond-test"));
    assert.ok(config.databasePath.endsWith(".tracepond-test/tracepond.duckdb"));
    assert.ok(config.opencodeHome.endsWith(".opencode-test"));
  } finally {
    restoreEnv("TRACEPOND_REFRESH_INTERVAL", previousRefreshInterval);
    restoreEnv("TRACEPOND_HOME", previousTracepondHome);
    restoreEnv("TRACEPOND_OPENCODE_HOME", previousOpenCodeHome);
  }
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
