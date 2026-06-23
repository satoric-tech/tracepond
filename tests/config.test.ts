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

test("storage profiles resolve layer defaults", () => {
  assert.deepEqual(resolveLayerConfig({ storageMode: "cache" }), {
    storageMode: "cache",
    bronzeMode: "table",
    silverMode: "view",
    goldMode: "view",
    searchMode: "off",
  });

  assert.deepEqual(resolveLayerConfig({ storageMode: "search" }), {
    storageMode: "search",
    bronzeMode: "table",
    silverMode: "view",
    goldMode: "view",
    searchMode: "table",
  });
});

test("explicit layer overrides win over storage profile defaults", () => {
  assert.deepEqual(resolveLayerConfig({
    storageMode: "cache",
    searchMode: "table",
  }), {
    storageMode: "cache",
    bronzeMode: "table",
    silverMode: "view",
    goldMode: "view",
    searchMode: "table",
  });
});

test("invalid layer config fails clearly", () => {
  assert.throws(
    () => resolveLayerConfig({ storageMode: "invalid" as never }),
    /Invalid storage mode/,
  );
});

test("resolveMemoryConfig reads env and normalizes paths", () => {
  const previousStorageMode = process.env.TRACEPOND_STORAGE_MODE;
  const previousRefreshInterval = process.env.TRACEPOND_REFRESH_INTERVAL;
  process.env.TRACEPOND_STORAGE_MODE = "search";
  process.env.TRACEPOND_REFRESH_INTERVAL = "2m";

  try {
    const config = resolveMemoryConfig({ cwd: "." });
    assert.equal(config.storageMode, "search");
    assert.equal(config.searchMode, "table");
    assert.equal(config.refreshIntervalMs, 120_000);
    assert.ok(config.cwd.startsWith("/"));
  } finally {
    restoreEnv("TRACEPOND_STORAGE_MODE", previousStorageMode);
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
