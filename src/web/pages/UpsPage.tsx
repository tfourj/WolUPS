import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BatteryCharging, ListTree, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { BatteryBar, EmptyState, PageHeader, ToneBadge } from "@/components/common";
import { ConfirmAction } from "@/components/confirm";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatRuntime, timeAgo, upsState } from "@/lib/format";
import { useAction } from "@/lib/mutations";
import type { Ups } from "@/lib/types";
import { UpsDialog } from "./UpsDialog";

function VarsDialog({ ups, onClose }: { ups: Ups | null; onClose: () => void }) {
  const { data, isPending } = useQuery({
    queryKey: ["ups-vars", ups?.id],
    queryFn: () => api.get<{ ok: boolean; vars: Record<string, string>; error?: string }>(`/ups/${ups!.id}/vars`),
    enabled: !!ups,
  });
  return (
    <Dialog open={!!ups} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{ups?.name} variables</DialogTitle>
        </DialogHeader>
        {isPending ? (
          <p className="text-muted-foreground text-sm">Loading...</p>
        ) : data?.ok ? (
          <ScrollArea className="h-96 rounded-md border">
            <table className="w-full text-sm">
              <tbody>
                {Object.entries(data.vars).map(([k, v]) => (
                  <tr key={k} className="border-b last:border-0">
                    <td className="text-muted-foreground px-3 py-1.5 font-mono text-xs">{k}</td>
                    <td className="px-3 py-1.5 font-mono text-xs break-all">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollArea>
        ) : (
          <p className="text-destructive text-sm">{data?.error}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function UpsPage() {
  const { data = [], isPending } = useQuery({
    queryKey: ["ups"],
    queryFn: () => api.get<Ups[]>("/ups"),
    refetchInterval: 5_000,
  });
  const [editing, setEditing] = useState<Ups | undefined>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [varsFor, setVarsFor] = useState<Ups | null>(null);

  const toggle = useAction((u: Ups) => api.patch(`/ups/${u.id}`, { enabled: !u.enabled }), {
    invalidate: [["ups"]],
  });
  const remove = useAction((u: Ups) => api.delete(`/ups/${u.id}`), {
    invalidate: [["ups"], ["overview"]],
    success: "UPS removed",
  });

  const openDialog = (u?: Ups) => {
    setEditing(u);
    setDialogOpen(true);
  };

  return (
    <>
      <PageHeader title="UPS">
        <Button onClick={() => openDialog()}>
          <Plus />
          Add UPS
        </Button>
      </PageHeader>

      {!isPending && data.length === 0 ? (
        <EmptyState icon={BatteryCharging} title="No UPS configured">
          <Button onClick={() => openDialog()}>Add UPS</Button>
        </EmptyState>
      ) : (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-40">Battery</TableHead>
                <TableHead className="hidden md:table-cell">Runtime</TableHead>
                <TableHead className="hidden md:table-cell">Load</TableHead>
                <TableHead className="hidden lg:table-cell">Polled</TableHead>
                <TableHead>Monitor</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((u) => {
                const state = upsState(u.status, u.reachable);
                return (
                  <TableRow key={u.id}>
                    <TableCell className="pl-4">
                      <p className="font-medium">{u.name}</p>
                      <p className="text-muted-foreground text-xs">
                        {u.upsName}@{u.host}
                        {u.port !== 3493 ? `:${u.port}` : ""}
                      </p>
                    </TableCell>
                    <TableCell>
                      <ToneBadge tone={u.enabled ? state.tone : "muted"}>{u.enabled ? state.label : "Paused"}</ToneBadge>
                      {u.lastError && (
                        <p className="text-destructive mt-1 max-w-56 truncate text-xs" title={u.lastError}>
                          {u.lastError}
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <BatteryBar value={u.battery} className="w-20" />
                        <span className="text-sm tabular-nums">{u.battery ?? "-"}%</span>
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">{formatRuntime(u.runtime)}</TableCell>
                    <TableCell className="hidden md:table-cell">{u.load ?? "-"}%</TableCell>
                    <TableCell className="text-muted-foreground hidden lg:table-cell">{timeAgo(u.lastPolledAt)}</TableCell>
                    <TableCell>
                      <Switch checked={u.enabled} onCheckedChange={() => toggle.mutate(u)} aria-label="Monitor" />
                    </TableCell>
                    <TableCell className="pr-4">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label="Actions">
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => openDialog(u)}>
                            <Pencil />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setVarsFor(u)}>
                            <ListTree />
                            Show variables
                          </DropdownMenuItem>
                          <ConfirmAction
                            title={`Delete ${u.name}?`}
                            description="Devices assigned to this UPS will no longer be shut down by it."
                            confirmLabel="Delete"
                            destructive
                            onConfirm={() => remove.mutateAsync(u)}
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
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}

      <UpsDialog open={dialogOpen} onOpenChange={setDialogOpen} ups={editing} />
      <VarsDialog ups={varsFor} onClose={() => setVarsFor(null)} />
    </>
  );
}
