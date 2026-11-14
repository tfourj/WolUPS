type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function configuredLevel(): Level {
  const value = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return value in order ? (value as Level) : "info";
}

const threshold = order[configuredLevel()];

function serializeError(value: unknown) {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  return value;
}

function write(level: Level, scope: string, msg: string, fields?: Record<string, unknown>) {
  if (order[level] < threshold) return;
  const entry: Record<string, unknown> = { ts: new Date().toISOString(), level, scope, msg };
  if (fields) {
    for (const [key, value] of Object.entries(fields)) entry[key] = serializeError(value);
  }
  const line = JSON.stringify(entry);
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export type Logger = ReturnType<typeof createLogger>;

export function createLogger(scope: string) {
  return {
    debug: (msg: string, fields?: Record<string, unknown>) => write("debug", scope, msg, fields),
    info: (msg: string, fields?: Record<string, unknown>) => write("info", scope, msg, fields),
    warn: (msg: string, fields?: Record<string, unknown>) => write("warn", scope, msg, fields),
    error: (msg: string, fields?: Record<string, unknown>) => write("error", scope, msg, fields),
  };
}
