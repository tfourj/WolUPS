import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every test run gets its own data directory, so the app's database is a throwaway file.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wolups-test-"));
process.env.BASE_URL = "http://localhost:4321";
process.env.LOG_LEVEL = "error";

const { runMigrations } = await import("../src/server/db/client");
runMigrations();
