import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { nutHosts, ups } from "../db/schema";
import { fetchUpsSnapshot, type NutTarget } from "../nut/client";
import { upsMonitor } from "../monitor/ups-monitor";
import { box } from "../secrets";
import { runNutCommand, type ApplyInput } from "./commands";

const NUT_PORT = 3493;
/** Drivers can take a while to start after the config is written. */
const VERIFY_TIMEOUT_MS = 30_000;
const VERIFY_INTERVAL_MS = 2_000;

export type ApplyOutcome = { ok: true; upsIds: string[] } | { ok: false; error: string; files?: string[] };

type Verify = (target: NutTarget, upsName: string) => Promise<unknown>;

/** Read each UPS from the server's side, retrying while drivers start. Returns the first lasting error. */
export async function verifyFromServer(
  target: NutTarget,
  names: string[],
  verify: Verify = fetchUpsSnapshot,
  timeoutMs = VERIFY_TIMEOUT_MS,
  intervalMs = VERIFY_INTERVAL_MS,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (const name of names) {
    for (;;) {
      try {
        await verify(target, name);
        break;
      } catch (error) {
        if (Date.now() + intervalMs > deadline) {
          const message = error instanceof Error ? error.message : String(error);
          return `could not read ${name} from ${target.host}:${target.port}: ${message}`;
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
  }
  return null;
}

/**
 * Write the NUT config on the host, check from the server that every UPS can be read on the listen address, then
 * create or update the UPS entries. Other UPS of the host stay as they are. Nothing is created when the server
 * cannot read a UPS.
 */
export async function applyNutConfig(
  hostId: string,
  input: ApplyInput,
  deps: { run?: typeof runNutCommand; verify?: Verify; timeoutMs?: number } = {},
): Promise<ApplyOutcome> {
  const run = deps.run ?? runNutCommand;
  const ack = await run(hostId, "nut_apply", {
    ups: input.ups.map(({ displayName: _, ...section }) => section),
    listen: input.listen,
    localShutdown: input.localShutdown,
  });
  if (!ack.ok) return { ok: false, error: ack.error ?? "the NUT agent could not apply the config" };
  const files = Array.isArray(ack.result?.files) ? (ack.result.files as string[]) : [];
  const username = typeof ack.result?.monitorUser === "string" ? ack.result.monitorUser : null;
  const password = typeof ack.result?.monitorPassword === "string" ? ack.result.monitorPassword : null;
  if (!username || !password) return { ok: false, error: "the NUT agent did not return the monitor login", files };

  const wanted = [...input.ups, ...input.imported];
  const target: NutTarget = { host: input.listen, port: NUT_PORT, username, password, timeoutMs: 5_000 };
  const error = await verifyFromServer(
    target,
    wanted.map((entry) => entry.name),
    deps.verify,
    deps.timeoutMs,
  );
  if (error) {
    return {
      ok: false,
      files,
      error: `${error}. Check that the WolUPS server can reach ${input.listen} on port ${NUT_PORT}.`,
    };
  }

  const passwordEnc = box.encrypt(password);
  const upsIds = db.transaction((tx) => {
    const ids: string[] = [];
    for (const entry of wanted) {
      const existing = tx
        .select()
        .from(ups)
        .where(and(eq(ups.nutHostId, hostId), eq(ups.upsName, entry.name)))
        .get();
      const values = { host: input.listen, port: NUT_PORT, username, passwordEnc, nutHostId: hostId };
      if (existing) {
        tx.update(ups).set(values).where(eq(ups.id, existing.id)).run();
        ids.push(existing.id);
      } else {
        const row = tx
          .insert(ups)
          .values({ ...values, name: entry.displayName, upsName: entry.name })
          .returning()
          .get();
        ids.push(row.id);
      }
    }
    tx.update(nutHosts)
      .set({ listenAddress: input.listen, localShutdown: input.localShutdown })
      .where(eq(nutHosts.id, hostId))
      .run();
    return ids;
  });
  upsMonitor.pollNow();
  return { ok: true, upsIds };
}

/**
 * Remove a UPS: its section leaves the WolUPS block on the host (a UPS imported from an existing config is left in
 * ups.conf), then its entry is deleted.
 */
export async function removeNutUps(
  hostId: string,
  upsId: string,
  deps: { run?: typeof runNutCommand } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const host = db.select().from(nutHosts).where(eq(nutHosts.id, hostId)).get();
  const row = db
    .select()
    .from(ups)
    .where(and(eq(ups.id, upsId), eq(ups.nutHostId, hostId)))
    .get();
  if (!host || !row) return { ok: false, error: "not found" };
  if (!host.listenAddress) return { ok: false, error: "this NUT host has not been set up yet" };
  const run = deps.run ?? runNutCommand;
  const ack = await run(hostId, "nut_apply", {
    ups: [],
    remove: [row.upsName],
    listen: host.listenAddress,
    localShutdown: host.localShutdown,
  });
  if (!ack.ok) return { ok: false, error: ack.error ?? "the NUT agent could not change the config" };
  db.delete(ups).where(eq(ups.id, row.id)).run();
  return { ok: true };
}
