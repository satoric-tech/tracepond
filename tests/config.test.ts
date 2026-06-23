import assert from "node:assert/strict";
import test from "node:test";
import { parseDurationMs, resolveLayerConfig, resolveMemoryConfig } from "../src/memory/duckdb.ts";

test("parseDurationMs uses standard duration strings", () => {
  assert.equal(parseDurationMs(undefined), undefined);
  assert.equal(parseDurationMs("0"), 0);
  assert.equal(parseDurationMs("30s"), 30_000);
  assert.equal(parseDurationMs("5m"), 300_000);
  assert.equal(parseDurationMs("1h"), 3_600_000);
  assert.throws(() => parseDurationMs("soon"), /Invalid refresh interval/);
});

test("layer policy is fixed and minimal", () => {
  assert.deepEqual(resolveLayerConfig(), {
    storageMode: "default",
    bronzeMode: "view",
    silverMode: "view",
    goldMode: "table",
    searchMode: "table",
  });
});

test("resolveMemoryConfig reads env and normalizes paths", () => {
  const previousRefreshInterval = process.env.TRACEPOND_REFRESH_INTERVAL;
  process.env.TRACEPOND_REFRESH_INTERVAL = "2m";

  try {
    const config = resolveMemoryConfig({ cwd: "." });
    assert.equal(config.storageMode, "default");
    assert.equal(config.searchMode, "table");
    assert.equal(config.refreshIntervalMs, 120_000);
    assert.ok(config.cwd.startsWith("/"));
  } finally {
    restoreEnv("TRACEPOND_REFRESH_INTERVAL", previousRefreshInterval);
  }
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
