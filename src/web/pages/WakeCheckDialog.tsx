import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import type { Device } from "@/lib/types";

type WakeCheck = {
  ok: boolean;
  mode: "auto" | "server" | "agent";
  mac: string | null;
  ip: string | null;
  server: { used: boolean; networks: string[]; sameNetwork: boolean; sendError: string | null };
  relays: { name: string; sameSubnet: boolean; sendError: string | null; tested: boolean }[];
  problems: string[];
};

function Row({ ok, label, detail }: { ok: boolean | null; label: string; detail: string }) {
  return (
    <div className="flex items-start gap-3 rounded-md border p-3">
      {ok === null ? (
        <span className="bg-muted-foreground/40 mt-1.5 size-2 shrink-0 rounded-full" />
      ) : ok ? (
        <CheckCircle2 className="text-success mt-0.5 size-4 shrink-0" />
      ) : (
        <XCircle className="text-destructive mt-0.5 size-4 shrink-0" />
      )}
      <div className="min-w-0 text-sm">
        <p className="font-medium">{label}</p>
        <p className="text-muted-foreground break-words">{detail}</p>
      </div>
    </div>
  );
}

function serverDetail(c: WakeCheck) {
  if (!c.server.used) return "Not used, wake packets are sent by relay agents only.";
  if (c.server.sendError) return `Could not send a test packet: ${c.server.sendError}`;
  if (!c.ip) return "Test packet sent. The device's network is unknown without a host IP.";
  if (c.server.sameNetwork) return `On ${c.ip}'s network, test packet sent.`;
  const seen = c.server.networks.join(", ") || "no networks";
  return `Not on ${c.ip}'s network, it only sees ${seen}. Use host networking to send from the server.`;
}

export function WakeCheckDialog({ device, onClose }: { device: Device | null; onClose: () => void }) {
  const { data, isFetching, error } = useQuery({
    queryKey: ["wake-check", device?.id],
    queryFn: () => api.post<WakeCheck>(`/devices/${device!.id}/wake-check`),
    enabled: !!device,
    gcTime: 0,
  });

  return (
    <Dialog open={!!device} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Wake-on-LAN check for {device?.name}</DialogTitle>
        </DialogHeader>
        {isFetching || !data ? (
          error ? (
            <p className="text-destructive text-sm">{error.message}</p>
          ) : (
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" />
              Sending test packets...
            </div>
          )
        ) : (
          <div className="grid gap-3">
            <div
              className={
                data.ok
                  ? "border-success/40 bg-success/10 text-success rounded-md border p-3 text-sm font-medium"
                  : "border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-3 text-sm font-medium"
              }
            >
              {data.ok ? "Wake packets can reach this device." : "Wake packets will not reach this device."}
            </div>
            <Row
              ok={data.server.used ? data.server.sameNetwork && !data.server.sendError : null}
              label="Server"
              detail={serverDetail(data)}
            />
            {data.mode !== "server" &&
              (data.relays.length === 0 ? (
                <Row ok={false} label="Relay agents" detail="No other agent is connected." />
              ) : (
                data.relays.map((r) => (
                  <Row
                    key={r.name}
                    ok={r.tested ? !r.sendError && r.sameSubnet : null}
                    label={`Agent ${r.name}`}
                    detail={[
                      r.sameSubnet ? "Same subnet" : "Different subnet",
                      r.tested ? (r.sendError ? `test failed: ${r.sendError}` : "test packet sent") : "backup relay",
                    ].join(", ")}
                  />
                ))
              ))}
            {data.problems.length > 0 && (
              <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm">
                {data.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            <p className="text-muted-foreground text-xs">
              Test packets use MAC 00:00:00:00:00:00, so nothing wakes up. The device itself still needs Wake-on-LAN
              enabled in its BIOS and network card.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
