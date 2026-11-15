import { describe, expect, test } from "bun:test";
import { desc, eq } from "drizzle-orm";
import { db } from "../src/server/db/client";
import { events } from "../src/server/db/schema";
import {
  flushAgentUpdateEvents,
  GROUP_MAX_MS,
  GROUP_QUIET_MS,
  groupDelay,
  groupedEvent,
  queueAgentUpdateEvent,
  type AgentUpdateEvent,
} from "../src/server/agents/update-events";

function updated(device: string, version = "0.1.4"): AgentUpdateEvent {
  return {
    deviceId: `id-${device}`,
    device,
    title: `${device} updated`,
    message: `Agent on ${device} updated from v0.1.3 to v${version}`,
    version,
    data: { device, version, previousVersion: "0.1.3" },
  };
}

describe("grouped agent update events", () => {
  test("a single agent keeps its own event", () => {
    expect(groupedEvent("agent_updated", [updated("nas")])).toEqual({
      type: "agent_updated",
      deviceId: "id-nas",
      title: "nas updated",
      message: "Agent on nas updated from v0.1.3 to v0.1.4",
      data: { device: "nas", version: "0.1.4", previousVersion: "0.1.3" },
    });
  });

  test("several agents become one event listing every device", () => {
    const event = groupedEvent("agent_updated", [updated("pve"), updated("nas"), updated("pi")]);
    expect(event).toMatchObject({
      deviceId: null,
      title: "3 agents updated",
      message: "Agents on nas, pi and pve updated to v0.1.4",
      data: { device: "nas, pi, pve", count: 3, version: "0.1.4", deviceIds: ["id-nas", "id-pi", "id-pve"] },
    });
  });

  test("failed updates list each error when they differ", () => {
    const failed = (device: string, error: string) => ({ ...updated(device), error });
    const same = groupedEvent("agent_update_failed", [failed("nas", "timeout"), failed("pve", "timeout")]);
    expect(same.message).toBe("Agents on nas and pve could not update: timeout");
    const mixed = groupedEvent("agent_update_failed", [failed("nas", "timeout"), failed("pve", "checksum mismatch")]);
    expect(mixed.message).toBe("Agents could not update: nas (timeout), pve (checksum mismatch)");
    expect(mixed.data?.error).toBe("timeout; checksum mismatch");
  });

  test("waits for a quiet window, but no longer than the maximum", () => {
    expect(groupDelay(0, 0)).toBe(GROUP_QUIET_MS);
    expect(groupDelay(0, GROUP_MAX_MS - 10_000)).toBe(10_000);
    expect(groupDelay(0, GROUP_MAX_MS + 1)).toBe(0);
  });

  test("queued events are recorded once as a group, keeping the latest per device", () => {
    queueAgentUpdateEvent("agent_update_available", { ...updated("nas", "0.1.4"), title: "old" });
    queueAgentUpdateEvent("agent_update_available", updated("nas", "0.1.5"));
    queueAgentUpdateEvent("agent_update_available", updated("pve", "0.1.5"));
    flushAgentUpdateEvents("agent_update_available");
    const rows = db
      .select()
      .from(events)
      .where(eq(events.type, "agent_update_available"))
      .orderBy(desc(events.id))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: "Agent update available for 2 agents",
      message: "Agent v0.1.5 is available for nas and pve",
    });
  });
});
