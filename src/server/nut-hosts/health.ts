import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { agents, nutHosts, ups, type NutServices } from "../db/schema";
import { agentHub, type NutStatusMessage } from "../agents/hub";
import { emitEvent } from "../events";

/** One thing wrong with a host's NUT setup. The key stays the same while the problem lasts. */
export type NutProblem = { key: string; ups: string | null; error: string; title: string; message: string };

type HostInfo = { name: string; localShutdown: boolean; upsNames: Map<string, string> };

/** "has failed", "has stopped", or "is <state>" for anything else, such as stale. */
function stateText(state: string): string {
  return state === "failed" || state === "stopped" ? `has ${state}` : `is ${state}`;
}

/** Problems in a health report. Services that are not installed yet are not problems. */
export function nutProblems(status: Omit<NutServices, "reportedAt">, host: HostInfo): NutProblem[] {
  const problems: NutProblem[] = [];
  const down = (state: string) => state !== "running" && state !== "missing";
  for (const driver of status.drivers) {
    if (!down(driver.state)) continue;
    const display = host.upsNames.get(driver.ups) ?? driver.ups;
    problems.push({
      key: `driver:${driver.ups}`,
      ups: display,
      error: `driver for ${driver.ups} ${stateText(driver.state)}`,
      title: `NUT driver stopped on ${host.name}`,
      message: `The NUT driver for ${display} ${stateText(driver.state)} on ${host.name}`,
    });
  }
  if (down(status.upsd)) {
    problems.push({
      key: "upsd",
      ups: null,
      error: `upsd ${stateText(status.upsd)}`,
      title: `upsd stopped on ${host.name}`,
      message: `The NUT server (upsd) ${stateText(status.upsd)} on ${host.name}`,
    });
  } else if (status.upsd === "running" && !status.listening) {
    problems.push({
      key: "listen",
      ups: null,
      error: "upsd is not listening on its address",
      title: `upsd not reachable on ${host.name}`,
      message: `The NUT server on ${host.name} is not listening on its configured address`,
    });
  }
  // upsmon only matters while it runs: a MONITOR line it cannot reach means this host would not shut down.
  if (status.upsmon === "running") {
    for (const monitor of status.monitors ?? []) {
      if (monitor.reachable) continue;
      const reason = monitor.error ?? "cannot connect";
      problems.push({
        key: `monitor:${monitor.system}`,
        ups: null,
        error: `upsmon cannot reach ${monitor.system}: ${reason}`,
        title: `upsmon cannot reach a UPS on ${host.name}`,
        message: `upsmon on ${host.name} cannot reach ${monitor.system} (${reason})`,
      });
    }
  }
  if (host.localShutdown && down(status.upsmon)) {
    problems.push({
      key: "upsmon",
      ups: null,
      error: `upsmon ${stateText(status.upsmon)}`,
      title: `upsmon stopped on ${host.name}`,
      message: `upsmon ${stateText(status.upsmon)} on ${host.name}, so it will not shut this host down`,
    });
  }
  return problems;
}

/**
 * Decide what to notify. A problem is notified once it shows up in two reports in a row, and recovers once it is
 * gone from two reports in a row, so a service restart between reports stays quiet.
 */
export function healthChanges(notified: string[], previous: string[], current: string[]) {
  const failed = current.filter((key) => previous.includes(key) && !notified.includes(key));
  const recovered = notified.filter((key) => !current.includes(key) && !previous.includes(key));
  const stillNotified = [...notified.filter((key) => !recovered.includes(key)), ...failed];
  return { failed, recovered, notified: stillNotified };
}

/** Problems of the previous report per host, for the two-reports rule. Lost on restart, which only delays. */
const previousReport = new Map<string, NutProblem[]>();

export function handleNutStatus(agentId: string, msg: NutStatusMessage) {
  const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
  if (!agent?.nutHostId) return;
  const host = db.select().from(nutHosts).where(eq(nutHosts.id, agent.nutHostId)).get();
  if (!host) return;
  const status: NutServices = {
    upsd: msg.upsd,
    upsmon: msg.upsmon,
    listening: msg.listening,
    drivers: msg.drivers,
    upsmonEnabled: msg.upsmonEnabled,
    monitors: msg.monitors,
    reportedAt: Date.now(),
  };
  const rows = db.select().from(ups).where(eq(ups.nutHostId, host.id)).all();
  // Only report health once WolUPS monitors a UPS from this host, not during setup.
  const current = rows.length
    ? nutProblems(status, {
        name: host.name,
        localShutdown: host.localShutdown,
        upsNames: new Map(rows.map((row) => [row.upsName, row.name])),
      })
    : [];
  const previous = previousReport.get(host.id) ?? [];
  previousReport.set(host.id, current);
  const changes = healthChanges(
    host.problems ?? [],
    previous.map((p) => p.key),
    current.map((p) => p.key),
  );

  db.update(nutHosts)
    .set({ services: status, problems: changes.notified })
    .where(eq(nutHosts.id, host.id))
    .run();

  const upsRow = (key: string) =>
    key.startsWith("driver:") ? rows.find((row) => row.upsName === key.slice("driver:".length)) : undefined;
  for (const key of changes.failed) {
    const problem = current.find((p) => p.key === key)!;
    emitEvent({
      type: "nut_service_failed",
      upsId: upsRow(key)?.id ?? null,
      title: problem.title,
      message: problem.message,
      data: { device: host.name, ups: problem.ups ?? undefined, error: problem.error },
    });
  }
  for (const key of changes.recovered) {
    const row = upsRow(key);
    const display = row?.name ?? (key.startsWith("driver:") ? key.slice("driver:".length) : null);
    const what: Record<string, string> = {
      upsd: "The NUT server (upsd) is running again",
      listen: "The NUT server is listening on its address again",
      upsmon: "upsmon is running again",
    };
    emitEvent({
      type: "nut_service_recovered",
      upsId: row?.id ?? null,
      title: `NUT running again on ${host.name}`,
      message: key.startsWith("monitor:")
        ? `upsmon on ${host.name} reaches ${key.slice("monitor:".length)} again`
        : `${what[key] ?? `The NUT driver for ${display} is running again`} on ${host.name}`,
      data: { device: host.name, ups: display ?? undefined },
    });
  }
}

agentHub.onNutStatus(handleNutStatus);
