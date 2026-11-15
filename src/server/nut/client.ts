import { Socket } from "node:net";
import {
  parseCmdList,
  parseEnumList,
  parseRangeList,
  parseRwList,
  parseType,
  parseUpsList,
  parseVarList,
  toSnapshot,
  type UpsSnapshot,
  type UpsVars,
  type WritableType,
} from "./parse";

export type NutTarget = {
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
  timeoutMs?: number;
};

export class NutError extends Error {}

const ERROR_HINTS: Record<string, string> = {
  "UNKNOWN-UPS": "unknown UPS name, check the name configured in NUT",
  "ACCESS-DENIED": "access denied, check the NUT username and password",
  "INVALID-USERNAME": "invalid NUT username",
  "INVALID-PASSWORD": "invalid NUT password",
  "USERNAME-REQUIRED": "this NUT server requires a username",
  "PASSWORD-REQUIRED": "this NUT server requires a password",
  "DATA-STALE": "the NUT driver reports stale data",
  "DRIVER-NOT-CONNECTED": "the NUT driver is not connected to the UPS",
};

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Minimal line-based NUT session over TCP. */
class NutSession {
  private buffer = "";
  private lines: string[] = [];
  private waiter: (() => void) | null = null;
  private failure: Error | null = null;

  constructor(private socket: Socket, private timeoutMs: number) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        this.lines.push(this.buffer.slice(0, idx).replace(/\r$/, ""));
        this.buffer = this.buffer.slice(idx + 1);
      }
      this.wake();
    });
    socket.on("error", (err) => this.fail(err));
    socket.on("close", () => this.fail(new NutError("connection closed by NUT server")));
  }

  private fail(err: Error) {
    if (!this.failure) this.failure = err;
    this.wake();
  }

  private wake() {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  private async nextLine(): Promise<string> {
    const deadline = Date.now() + this.timeoutMs;
    while (this.lines.length === 0) {
      if (this.failure) throw this.failure;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new NutError("timed out waiting for NUT server");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiter = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    return this.lines.shift()!;
  }

  private checkError(line: string) {
    if (line.startsWith("ERR ")) {
      const code = line.slice(4).trim().split(/\s+/)[0];
      throw new NutError(ERROR_HINTS[code] ?? `NUT error ${code}`);
    }
  }

  async simple(command: string): Promise<string> {
    this.socket.write(`${command}\n`);
    const line = await this.nextLine();
    this.checkError(line);
    return line;
  }

  async list(command: string): Promise<string[]> {
    this.socket.write(`${command}\n`);
    const first = await this.nextLine();
    this.checkError(first);
    if (!first.startsWith("BEGIN LIST")) throw new NutError(`unexpected NUT response: ${first}`);
    const out: string[] = [];
    for (;;) {
      const line = await this.nextLine();
      if (line.startsWith("END LIST")) return out;
      this.checkError(line);
      out.push(line);
    }
  }

  close() {
    try {
      this.socket.write("LOGOUT\n");
    } catch {
      // ignore
    }
    this.socket.destroy();
  }
}

async function withSession<T>(target: NutTarget, run: (s: NutSession) => Promise<T>): Promise<T> {
  const timeoutMs = target.timeoutMs ?? 5000;
  const socket = new Socket();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new NutError(`could not connect to ${target.host}:${target.port} (timeout)`));
    }, timeoutMs);
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(new NutError(`could not connect to ${target.host}:${target.port}: ${err.message}`));
    });
    socket.connect(target.port, target.host, () => {
      clearTimeout(timer);
      resolve();
    });
  });
  const session = new NutSession(socket, timeoutMs);
  try {
    if (target.username) await session.simple(`USERNAME ${quote(target.username)}`);
    if (target.password) await session.simple(`PASSWORD ${quote(target.password)}`);
    return await run(session);
  } finally {
    session.close();
  }
}

export async function fetchUpsVars(target: NutTarget, upsName: string): Promise<UpsVars> {
  return withSession(target, async (s) => parseVarList(await s.list(`LIST VAR ${upsName}`)));
}

export async function fetchUpsSnapshot(target: NutTarget, upsName: string): Promise<UpsSnapshot> {
  return toSnapshot(await fetchUpsVars(target, upsName));
}

export async function listUps(target: NutTarget) {
  return withSession(target, async (s) => parseUpsList(await s.list("LIST UPS")));
}

export type WritableVar = {
  name: string;
  value: string;
  type: WritableType;
  options?: string[];
  ranges?: { min: number; max: number }[];
};

/** Instant commands and writable variables of a UPS. Listing needs no login. */
export async function fetchUpsControls(target: NutTarget, upsName: string) {
  return withSession(target, async (s) => {
    const commands = parseCmdList(await s.list(`LIST CMD ${upsName}`));
    const writable: WritableVar[] = [];
    for (const [name, value] of Object.entries(parseRwList(await s.list(`LIST RW ${upsName}`)))) {
      const type = parseType(await s.simple(`GET TYPE ${upsName} ${name}`));
      const entry: WritableVar = { name, value, type };
      if (type.kind === "enum") entry.options = parseEnumList(await s.list(`LIST ENUM ${upsName} ${name}`));
      if (type.kind === "range") entry.ranges = parseRangeList(await s.list(`LIST RANGE ${upsName} ${name}`));
      writable.push(entry);
    }
    return { commands, writable };
  });
}
