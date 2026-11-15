import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { agents, nutHosts, ups } from "../db/schema";
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

/** Names and addresses a UPS entry added by hand may use for this host's NUT server. */
export function hostAddresses(hostId: string, listen?: string): string[] {
  const host = db.select().from(nutHosts).where(eq(nutHosts.id, hostId)).get();
  const agent = db.select().from(agents).where(eq(agents.nutHostId, hostId)).get();
  const ips = (agent?.interfaces ?? []).flatMap((iface) => iface.cidrs.map((cidr) => cidr.split("/")[0]));
  const names = [agent?.hostname, agent?.hostname ? `${agent.hostname}.local` : null, host?.name, host?.listenAddress];
  return [...new Set([...ips, ...names, listen].filter((v): v is string => !!v).map((v) => v.toLowerCase()))];
}

/**
 * UPS entries added by hand that point at this host's NUT server with one of the given UPS names. Applying takes
 * them over instead of adding a second entry, so their devices, history and outages stay.
 */
export function adoptableUps(hostId: string, names: string[], listen?: string) {
  if (names.length === 0) return [];
  const addresses = new Set(hostAddresses(hostId, listen));
  return db
    .select()
    .from(ups)
    .where(and(isNull(ups.nutHostId), inArray(ups.upsName, names)))
    .all()
    .filter((row) => addresses.has(row.host.toLowerCase()));
}

/** The nut_apply arguments for a wizard request. */
function applyArgs(input: ApplyInput, dryRun = false) {
  return {
    ups: input.ups.map(({ displayName: _, ...section }) => section),
    migrate: input.migrate ? input.imported.map((entry) => entry.name) : [],
    edit: input.edit.map(({ displayName: _, ...edit }) => edit),
    listen: input.listen,
    localShutdown: input.localShutdown,
    ...(dryRun ? { dryRun: true } : {}),
  };
}

export type FileChange = { path: string; before: string; after: string };

export type PreviewOutcome =
  | { ok: true; changes: FileChange[]; adopt: { id: string; name: string; upsName: string }[] }
  | { ok: false; error: string };

/** What applying would change on the host, file by file, with passwords masked. Nothing is written. */
export async function previewNutConfig(
  hostId: string,
  input: ApplyInput,
  deps: { run?: typeof runNutCommand } = {},
): Promise<PreviewOutcome> {
  const run = deps.run ?? runNutCommand;
  const ack = await run(hostId, "nut_apply", applyArgs(input, true));
  if (!ack.ok) return { ok: false, error: ack.error ?? "the NUT agent could not prepare the config" };
  const names = [...input.ups, ...input.imported, ...input.edit].map((entry) => entry.name);
  return {
    ok: true,
    changes: Array.isArray(ack.result?.changes) ? (ack.result.changes as FileChange[]) : [],
    adopt: adoptableUps(hostId, names, input.listen).map(({ id, name, upsName }) => ({ id, name, upsName })),
  };
}

/**
 * Write the NUT config on the host, check from the server that every UPS can be read on the listen address, then
 * create or update the UPS entries. Entries added by hand for the same UPS are taken over. Other UPS of the host
 * stay as they are. Nothing is created when the server cannot read a UPS.
 */
export async function applyNutConfig(
  hostId: string,
  input: ApplyInput,
  deps: { run?: typeof runNutCommand; verify?: Verify; timeoutMs?: number } = {},
): Promise<ApplyOutcome> {
  const run = deps.run ?? runNutCommand;
  const ack = await run(hostId, "nut_apply", applyArgs(input));
  if (!ack.ok) return { ok: false, error: ack.error ?? "the NUT agent could not apply the config" };
  const files = Array.isArray(ack.result?.files) ? (ack.result.files as string[]) : [];
  const username = typeof ack.result?.monitorUser === "string" ? ack.result.monitorUser : null;
  const password = typeof ack.result?.monitorPassword === "string" ? ack.result.monitorPassword : null;
  if (!username || !password) return { ok: false, error: "the NUT agent did not return the monitor login", files };

  const wanted = [...input.ups, ...input.imported, ...input.edit];
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
  const adoptable = adoptableUps(
    hostId,
    wanted.map((entry) => entry.name),
    input.listen,
  );
  const adopt = new Map(adoptable.map((row) => [row.upsName, row]));
  const upsIds = db.transaction((tx) => {
    const ids: string[] = [];
    for (const entry of wanted) {
      const existing =
        tx
          .select()
          .from(ups)
          .where(and(eq(ups.nutHostId, hostId), eq(ups.upsName, entry.name)))
          .get() ?? adopt.get(entry.name);
      const values = { host: input.listen, port: NUT_PORT, username, passwordEnc, nutHostId: hostId };
      if (existing) {
        // The wizard sends the display name it shows, so this also renames an entry.
        tx.update(ups)
          .set({ ...values, name: entry.displayName })
          .where(eq(ups.id, existing.id))
          .run();
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
