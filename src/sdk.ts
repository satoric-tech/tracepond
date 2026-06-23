import { formatQueryResult, MemoryDuckDb, type MemoryConfig, type MemoryOptions, type QueryResult } from "./memory/duckdb.js";

export type TracepondOptions = MemoryOptions;

export { formatQueryResult, type MemoryConfig, type MemoryOptions, type QueryResult };

export async function query(sql: string, options: TracepondOptions = {}): Promise<QueryResult> {
  const db = await MemoryDuckDb.open(options);
  try {
    return await db.query(sql);
  } finally {
    await db.close();
  }
}

export async function describe(options: TracepondOptions = {}): Promise<string> {
  const db = await MemoryDuckDb.open(options);
  try {
    return await db.describe();
  } finally {
    await db.close();
  }
}

export async function refresh(options: TracepondOptions = {}): Promise<void> {
  const db = await MemoryDuckDb.open({ ...options, refreshIntervalMs: 0 });
  try {
    // Opening the database performs the global refresh path.
  } finally {
    await db.close();
  }
}
