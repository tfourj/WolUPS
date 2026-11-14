import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { env } from "../env";
import { createLogger } from "../logger";
import * as schema from "./schema";

const log = createLogger("db");

export function openDatabase(path: string) {
  const sqlite = new Database(path, { create: true, strict: true });
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec("PRAGMA busy_timeout = 5000");
  return { sqlite, db: drizzle(sqlite, { schema, casing: "snake_case" }) };
}

export type DB = ReturnType<typeof openDatabase>["db"];

const opened = openDatabase(env.dbPath);
export const sqlite = opened.sqlite;
export const db = opened.db;

export function runMigrations(target: DB = db, folder = env.migrationsDir) {
  migrate(target, { migrationsFolder: folder });
  log.info("migrations applied", { folder });
}
