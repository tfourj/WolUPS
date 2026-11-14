import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, CircleHelp, Loader2, XCircle } from "lucide-react";
import { api } from "@/lib/api";

export type WakeDelivery = {
  ok: boolean;
  mode: "auto" | "server" | "agent";
  server: { used: boolean; networks: string[]; sendError: string | null };
  agents: { name: string; networks: string[]; sendError: string | null }[];
  devices: { id: string; name: string; ip: string | null; reachable: boolean | null; via: string[] }[];
};

export const WAKE_DELIVERY_KEY = ["wake-delivery"];

function Status({ ok }: { ok: boolean | null }) {
  if (ok === null) return <CircleHelp className="text-muted-foreground mt-0.5 size-4 shrink-0" />;
  return ok ? (
    <CheckCircle2 className="text-success mt-0.5 size-4 shrink-0" />
  ) : (
    <XCircle className="text-destructive mt-0.5 size-4 shrink-0" />
  );
}

function Line({ ok, label, detail }: { ok: boolean | null; label: string; detail: string }) {
  return (
    <li className="flex items-start gap-2.5">
      <Status ok={ok} />
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-muted-foreground text-xs break-words">{detail}</p>
      </div>
    </li>
  );
}

/** Live Wake-on-LAN status: tests each sender with a harmless packet and lists device coverage. */
export function WakeDeliveryStatus() {
  const { data, isFetching, error } = useQuery({
    queryKey: WAKE_DELIVERY_KEY,
    queryFn: () => api.post<WakeDelivery>("/settings/wake-check"),
    staleTime: 0,
    gcTime: 0,
  });

  if (isFetching && !data) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loader2 className="size-4 animate-spin" />
        Sending test packets...
      </div>
    );
  }
  if (error || !data) return <p className="text-destructive text-sm">{error?.message ?? "Check failed"}</p>;

  const unreachable = data.devices.filter((d) => d.reachable === false);
  const unknown = data.devices.filter((d) => d.reachable === null);
  const reachable = data.devices.filter((d) => d.reachable);

  return (
    <ul className={isFetching ? "grid gap-3 opacity-60" : "grid gap-3"}>
      {data.server.used ? (
        <Line
          ok={!data.server.sendError}
          label="Server"
          detail={
            data.server.sendError
              ? `Could not send: ${data.server.sendError}`
              : `Test packet sent. Networks: ${data.server.networks.join(", ") || "none"}`
          }
        />
      ) : (
        <Line ok={null} label="Server" detail="Not used" />
      )}
      {data.mode !== "server" &&
        (data.agents.length === 0 ? (
          <Line ok={false} label="Relay agents" detail="No agent is connected" />
        ) : (
          data.agents.map((a) => (
            <Line
              key={a.name}
              ok={!a.sendError}
              label={`Agent ${a.name}`}
              detail={
                a.sendError ? `Could not send: ${a.sendError}` : `Test packet sent. Networks: ${a.networks.join(", ")}`
              }
            />
          ))
        ))}
      {data.devices.length > 0 && (
        <Line
          ok={unreachable.length === 0 ? (reachable.length > 0 ? true : null) : false}
          label={`Devices reachable: ${reachable.length} of ${data.devices.length}`}
          detail={[
            ...unreachable.map((d) => `${d.name} (${d.ip}) is not on the server's or a working agent's network`),
            ...unknown.map((d) => `${d.name} has no host IP, so its network is unknown`),
          ].join(". ") || "Every device with Wake-on-LAN can be reached"}
        />
      )}
    </ul>
  );
}
