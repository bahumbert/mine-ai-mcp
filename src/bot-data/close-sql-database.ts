// Closing a node:sqlite connection so the file is released before the call returns (Bun leaves statements open otherwise).
import type { DatabaseSync } from "node:sqlite";

/**
 * Closes a connection and releases the underlying file before returning.
 *
 * Bun's `node:sqlite` leaves a closed database's outstanding statements unfinalised, so the
 * native connection — and, on Windows, the lock on the database file — survives until the
 * orphaned statement wrappers are collected. Node finalises them during `close`, so the
 * collection below only runs under Bun.
 */
export function closeSqlDatabase(database: DatabaseSync): void {
  database.close();
  collectOrphanedStatements?.(true);
}

const collectOrphanedStatements = (globalThis as { Bun?: { gc: (synchronous: boolean) => void } }).Bun?.gc;
