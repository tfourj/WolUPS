import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Download,
  MoreHorizontal,
  Pencil,
  Plus,
  Radar,
  Power,
  RefreshCw,
  Server,
  Sunrise,
  Trash2,
  Unlink,
  Wifi,
} from "lucide-react";
import { toast } from "sonner";
import { EmptyState, PageHeader, ToneBadge } from "@/components/common";
import { ConfirmAction } from "@/components/confirm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { formatDateTime, timeAgo } from "@/lib/format";
import { useAction } from "@/lib/mutations";
import type { Device } from "@/lib/types";
import { DeviceDialog } from "./DeviceDialog";
import { InstallAgentDialog } from "./InstallAgentDialog";
import { WakeCheckDialog } from "./WakeCheckDialog";

type UpdateCheck =
  | { ok: true; status: "current" | "updating"; version: string | null; latestVersion: string }
  | { ok: false; error: string };

type Ack = { ok: boolean; error?: string; latencyMs?: number; via?: string[]; errors?: string[] };

function AgentCell({ device }: { device: Device }) {
  const agent = device.agent;
  if (!agent) return <span className="text-muted-foreground text-sm">Not installed</span>;
  const updating = agent.updateStatus === "updating" || agent.updateStatus === "restarting";
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <ToneBadge tone={agent.connected ? "success" : "error"}>
              {agent.connected ? "Connected" : "Offline"}
            </ToneBadge>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {agent.hostname} ({agent.arch}), last seen {timeAgo(agent.lastSeenAt)}
        </TooltipContent>
      </Tooltip>
      {agent.version && <span className="text-muted-foreground font-mono text-xs">v{agent.version}</span>}
      {updating && <Badge variant="secondary">Updating</Badge>}
      {!updating && agent.updateAvailable && (
        <Badge variant="outline" className="border-info/40 text-info">
          v{agent.latestVersion} available
        </Badge>
      )}
      {agent.updateStatus === "failed" && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="border-destructive/40 text-destructive">
              Update failed
            </Badge>
          </TooltipTrigger>
          <TooltipContent>{agent.lastUpdateError}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

export function DevicesPage() {
  const { data = [], isPending } = useQuery({
    queryKey: ["devices"],
    queryFn: () => api.get<Device[]>("/devices"),
    refetchInterval: 5_000,
  });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Device | undefined>();
  const [installFor, setInstallFor] = useState<Device | null>(null);
  const [wakeCheckFor, setWakeCheckFor] = useState<Device | null>(null);

  const invalidate = [["devices"], ["overview"]];
  const wake = useAction((d: Device) => api.post<Ack>(`/devices/${d.id}/wake`), {
    invalidate,
    success: (r) => (r.ok ? `Wake packet sent via ${r.via?.join(", ")}` : null),
  });
  const shutdown = useAction((d: Device) => api.post<Ack>(`/devices/${d.id}/shutdown`), {
    invalidate,
    success: (r) => (r.ok ? "Shutdown accepted" : null),
  });
  const ping = useAction((d: Device) => api.post<Ack>(`/devices/${d.id}/agent/ping`), {
    success: (r) => (r.ok ? `Agent responded in ${r.latencyMs} ms` : null),
  });
  const queryClient = useQueryClient();
  const checkForUpdate = (d: Device) => {
    const request = api
      .post<UpdateCheck>(`/devices/${d.id}/agent/update`)
      .then((r) => {
        if (!r.ok) throw new Error(r.error);
        return r;
      })
      .finally(() => {
        for (const key of invalidate) queryClient.invalidateQueries({ queryKey: key });
      });
    toast.promise(request, {
      loading: `Checking ${d.name} for an update...`,
      success: (r) =>
        r.status === "current"
          ? `${d.name} is up to date (v${r.version ?? r.latestVersion})`
          : `${d.name} is updating to v${r.latestVersion} and will reconnect shortly`,
      error: (e) => `Update check failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  };
  const autoUpdate = useAction(
    (d: Device) => api.patch(`/devices/${d.id}/agent`, { autoUpdate: !d.agent?.autoUpdate }),
    { invalidate },
  );
  const unpair = useAction(
    async ({ device, force }: { device: Device; force: boolean }) =>
      api.post<Ack>(`/devices/${device.id}/agent/unpair`, { force }),
    { invalidate, success: "Agent unpaired" },
  );
  const remove = useAction((d: Device) => api.delete(`/devices/${d.id}`), { invalidate, success: "Device removed" });

  const report = (r: Ack) => {
    if (!r.ok) toast.error(r.error ?? r.errors?.join("; ") ?? "Failed");
  };

  const openDialog = (d?: Device) => {
    setEditing(d);
    setDialogOpen(true);
  };

  return (
    <>
      <PageHeader title="Devices">
        <Button onClick={() => openDialog()}>
          <Plus />
          Add device
        </Button>
      </PageHeader>

      {!isPending && data.length === 0 ? (
        <EmptyState icon={Server} title="No devices yet">
          <Button onClick={() => openDialog()}>Add device</Button>
        </EmptyState>
      ) : (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Device</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead className="hidden xl:table-cell">UPS</TableHead>
                <TableHead className="hidden lg:table-cell">Shutdown</TableHead>
                <TableHead className="hidden lg:table-cell">Wake</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="pl-4">
                    <p className="font-medium">{d.name}</p>
                    <p className="text-muted-foreground font-mono text-xs">
                      {[d.host, d.mac].filter(Boolean).join(" · ") || "-"}
                    </p>
                  </TableCell>
                  <TableCell>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span>
                          <ToneBadge tone={d.online ? "success" : "muted"}>{d.online ? "Online" : "Offline"}</ToneBadge>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>Last seen {formatDateTime(d.lastSeenAt)}</TooltipContent>
                    </Tooltip>
                  </TableCell>
                  <TableCell>
                    <AgentCell device={d} />
                  </TableCell>
                  <TableCell className="hidden xl:table-cell">{d.upsName ?? "-"}</TableCell>
                  <TableCell className="hidden lg:table-cell">
                    {d.shutdownEnabled ? (
                      <span className="text-sm">
                        at {d.shutdownBatteryPercent}%
                        {d.shutdownRuntimeSec ? ` or ${d.shutdownRuntimeSec}s` : ""}
                        {!d.agent && <span className="text-warning block text-xs">needs agent</span>}
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-sm">Off</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <span className={d.wakeEnabled && d.mac ? "text-sm" : "text-muted-foreground text-sm"}>
                      {!d.wakeEnabled ? "Off" : !d.mac ? "No MAC" : d.alwaysWake ? "Always" : "If was online"}
                      {d.wakeEnabled && d.mac && d.wakeMinBatteryPercent !== null && (
                        <span className="text-muted-foreground block text-xs">above {d.wakeMinBatteryPercent}%</span>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="pr-4">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label="Actions">
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-52">
                        <DropdownMenuItem onClick={() => openDialog(d)}>
                          <Pencil />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setInstallFor(d)}>
                          <Download />
                          {d.agent ? "Reinstall agent" : "Install agent"}
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled={!d.mac} onClick={() => wake.mutateAsync(d).then(report)}>
                          <Sunrise />
                          Wake now
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setWakeCheckFor(d)}>
                          <Radar />
                          Check Wake-on-LAN
                        </DropdownMenuItem>
                        {d.agent && (
                          <>
                            <ConfirmAction
                              title={`Shut down ${d.name}?`}
                              description="The agent will power off this machine right away."
                              confirmLabel="Shut down"
                              destructive
                              onConfirm={() => shutdown.mutateAsync(d).then(report)}
                              trigger={
                                <DropdownMenuItem
                                  disabled={!d.agent.connected}
                                  onSelect={(e) => e.preventDefault()}
                                >
                                  <Power />
                                  Shut down now
                                </DropdownMenuItem>
                              }
                            />
                            <DropdownMenuSeparator />
                            <DropdownMenuLabel>Agent</DropdownMenuLabel>
                            <DropdownMenuItem
                              disabled={!d.agent.connected}
                              onClick={() => ping.mutateAsync(d).then(report)}
                            >
                              <Wifi />
                              Test connection
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={!d.agent.connected}
                              onClick={() => checkForUpdate(d)}
                            >
                              <RefreshCw />
                              Check for update
                            </DropdownMenuItem>
                            <DropdownMenuCheckboxItem
                              checked={d.agent.autoUpdate}
                              onCheckedChange={() => autoUpdate.mutate(d)}
                            >
                              Automatic updates
                            </DropdownMenuCheckboxItem>
                            <ConfirmAction
                              title={`Unpair agent on ${d.name}?`}
                              description={
                                d.agent.connected
                                  ? "The agent removes its pairing and stops."
                                  : "The agent is offline. WolUPS forgets it now; run `wolups-agent reset --confirm` on the device later."
                              }
                              confirmLabel="Unpair"
                              destructive
                              onConfirm={() => unpair.mutateAsync({ device: d, force: !d.agent!.connected })}
                              trigger={
                                <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                                  <Unlink />
                                  Unpair
                                </DropdownMenuItem>
                              }
                            />
                          </>
                        )}
                        <DropdownMenuSeparator />
                        <ConfirmAction
                          title={`Delete ${d.name}?`}
                          description="Its agent is unpaired as well. Events are kept."
                          confirmLabel="Delete"
                          destructive
                          onConfirm={() => remove.mutateAsync(d)}
                          trigger={
                            <DropdownMenuItem variant="destructive" onSelect={(e) => e.preventDefault()}>
                              <Trash2 />
                              Delete
                            </DropdownMenuItem>
                          }
                        />
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <DeviceDialog open={dialogOpen} onOpenChange={setDialogOpen} device={editing} />
      <InstallAgentDialog device={installFor} onClose={() => setInstallFor(null)} />
      <WakeCheckDialog device={wakeCheckFor} onClose={() => setWakeCheckFor(null)} />
    </>
  );
}
