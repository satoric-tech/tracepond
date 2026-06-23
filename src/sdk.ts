import { formatQueryResult, MemoryDuckDb, type MemoryConfig, type QueryResult } from "./memory/duckdb.js";

export type TracepondOptions = Partial<Omit<
  MemoryConfig,
  "storageMode" | "bronzeMode" | "silverMode" | "goldMode" | "searchMode"
>>;

export { formatQueryResult, type MemoryConfig, type QueryResult };

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
