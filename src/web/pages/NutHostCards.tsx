import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Download,
  FileText,
  MoreHorizontal,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  RotateCw,
  Terminal,
  Trash2,
} from "lucide-react";
import { ToneBadge } from "@/components/common";
import { ConfirmAction } from "@/components/confirm";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";
import { useAction } from "@/lib/mutations";
import type { NutHost } from "@/lib/types";
import type { WizardStep } from "./NutHostWizard";

function LogsDialog({ host, onClose }: { host: NutHost | null; onClose: () => void }) {
  const { data, isPending, error } = useQuery({
    queryKey: ["nut-logs", host?.id],
    queryFn: () => api.post<{ log: string[] }>(`/nut-hosts/${host!.id}/logs`, { lines: 200 }),
    enabled: !!host,
  });
  return (
    <Dialog open={!!host} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>NUT logs on {host?.name}</DialogTitle>
        </DialogHeader>
        <div className="bg-muted/50 max-h-[60vh] overflow-auto rounded-md border p-3 font-mono text-xs">
          {isPending && <div className="text-muted-foreground">Loading...</div>}
          {error && <div className="text-destructive">{error.message}</div>}
          {data?.log.map((line, i) => (
            <div key={i} className="break-all whitespace-pre-wrap">
              {line}
            </div>
          ))}
          {data && data.log.length === 0 && <div className="text-muted-foreground">No log lines</div>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** upsmon on the host: whether it runs and which MONITOR targets it cannot reach. Null when NUT has no upsmon. */
function upsmonState(host: NutHost) {
  const services = host.services;
  if (!services || services.upsmon === "missing") return null;
  const running = services.upsmon === "running";
  const unreachable = running ? (services.monitors ?? []).filter((m) => !m.reachable) : [];
  return { running, unreachable };
}

function hostState(host: NutHost) {
  if (!host.agent) return { tone: "muted" as const, label: "Not paired" };
  if (!host.agent.connected) return { tone: "error" as const, label: "Offline" };
  if (host.problems?.length) return { tone: "warning" as const, label: "NUT problem" };
  return { tone: "success" as const, label: "Connected" };
}

/** NUT hosts on the UPS page, each with its agent, NUT state and actions. */
export function NutHostCards({
  hosts,
  onOpenWizard,
}: {
  hosts: NutHost[];
  onOpenWizard: (host: NutHost, step: WizardStep) => void;
}) {
  const [logsFor, setLogsFor] = useState<NutHost | null>(null);
  const restart = useAction((h: NutHost) => api.post(`/nut-hosts/${h.id}/service`, { action: "restart" }), {
    invalidate: [["nut-hosts"]],
    success: "NUT restarted",
  });
  const update = useAction(
    (h: NutHost) =>
      api.post<{ ok: boolean; status?: string; latestVersion?: string; error?: string }>(
        `/nut-hosts/${h.id}/agent/update`,
      ),
    {
      invalidate: [["nut-hosts"]],
      success: (r) => (r.ok ? (r.status === "updating" ? `Updating to v${r.latestVersion}` : "Up to date") : null),
    },
  );
  const autoUpdate = useAction(
    (h: NutHost) => api.patch(`/nut-hosts/${h.id}/agent`, { autoUpdate: !h.agent?.autoUpdate }),
    { invalidate: [["nut-hosts"]] },
  );
  const upsmon = useAction(
    ({ host, enabled }: { host: NutHost; enabled: boolean }) =>
      api.post(`/nut-hosts/${host.id}/upsmon`, { enabled }),
    { invalidate: [["nut-hosts"]], success: "upsmon updated" },
  );
  const remove = useAction((h: NutHost) => api.delete(`/nut-hosts/${h.id}`), {
    invalidate: [["nut-hosts"], ["ups"]],
    success: "NUT host removed",
  });

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {hosts.map((host) => {
        const state = hostState(host);
        const monitor = upsmonState(host);
        const details = [
          host.nutVersion ? `NUT v${host.nutVersion}` : "NUT not installed",
          host.agent?.version ? `agent v${host.agent.version}` : null,
          host.listenAddress,
          host.sameMachine ? "same machine as WolUPS" : null,
        ].filter(Boolean);
        return (
          <Card key={host.id} className="py-4">
            <CardContent className="flex items-start justify-between gap-3 px-4">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">{host.name}</p>
                  <ToneBadge tone={state.tone}>{state.label}</ToneBadge>
                  {host.agent?.updateAvailable && <ToneBadge tone="info">Update available</ToneBadge>}
                </div>
                <p className="text-muted-foreground text-xs">{details.join(" · ")}</p>
                <p className="text-muted-foreground text-xs">
                  {host.ups.length ? host.ups.map((u) => u.name).join(", ") : "No UPS yet"}
                </p>
                {monitor && (
                  <p className="text-muted-foreground text-xs">upsmon {monitor.running ? "running" : "off"}</p>
                )}
                {monitor?.unreachable.map((m) => (
                  <p key={m.system} className="text-warning text-xs">
                    upsmon cannot reach {m.system} ({m.error ?? "cannot connect"})
                  </p>
                ))}
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="Actions">
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => onOpenWizard(host, "check")} disabled={!host.agent?.connected}>
                    <Plus />
                    {host.ups.length ? "Add UPS" : "Continue setup"}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => restart.mutate(host)} disabled={!host.agent?.connected}>
                    <RotateCw />
                    Restart NUT
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setLogsFor(host)} disabled={!host.agent?.connected}>
                    <FileText />
                    Logs
                  </DropdownMenuItem>
                  {monitor &&
                    (monitor.running ? (
                      <ConfirmAction
                        title={`Turn off upsmon on ${host.name}?`}
                        description={
                          `${host.name} stops shutting itself down when the UPS runs low. WolUPS keeps ` +
                          "monitoring its UPS and still shuts down devices with agents."
                        }
                        confirmLabel="Turn off"
                        onConfirm={() => upsmon.mutateAsync({ host, enabled: false })}
                        trigger={
                          <DropdownMenuItem onSelect={(e) => e.preventDefault()} disabled={!host.agent?.connected}>
                            <PowerOff />
                            Turn off upsmon
                          </DropdownMenuItem>
                        }
                      />
                    ) : (
                      <DropdownMenuItem
                        onClick={() => upsmon.mutate({ host, enabled: true })}
                        disabled={!host.agent?.connected}
                      >
                        <Power />
                        Turn on upsmon
                      </DropdownMenuItem>
                    ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => onOpenWizard(host, "install")}>
                    <Terminal />
                    Install command
                  </DropdownMenuItem>
                  {host.agent && (
                    <>
                      <DropdownMenuItem onClick={() => update.mutate(host)} disabled={!host.agent.connected}>
                        {update.isPending ? <RefreshCw className="animate-spin" /> : <Download />}
                        Check for update
                      </DropdownMenuItem>
                      <DropdownMenuCheckboxItem
                        checked={host.agent.autoUpdate}
                        onCheckedChange={() => autoUpdate.mutate(host)}
                      >
                        Automatic updates
                      </DropdownMenuCheckboxItem>
                    </>
                  )}
                  <DropdownMenuSeparator />
                  <ConfirmAction
                    title={`Remove ${host.name}?`}
                    description="The NUT agent is unpaired. NUT keeps running on the host and its UPS stay in WolUPS."
                    confirmLabel="Remove"
                    destructive
                    onConfirm={() => remove.mutateAsync(host)}
                    trigger={
                      <DropdownMenuItem variant="destructive" onSelect={(e) => e.preventDefault()}>
                        <Trash2 />
                        Remove
                      </DropdownMenuItem>
                    }
                  />
                </DropdownMenuContent>
              </DropdownMenu>
            </CardContent>
          </Card>
        );
      })}
      <LogsDialog host={logsFor} onClose={() => setLogsFor(null)} />
    </div>
  );
}
