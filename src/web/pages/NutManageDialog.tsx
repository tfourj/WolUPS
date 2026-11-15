import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Play, RotateCw, Trash2 } from "lucide-react";
import { ToneBadge } from "@/components/common";
import { ConfirmAction } from "@/components/confirm";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { useAction } from "@/lib/mutations";
import type { NutHost, Ups, UpsControls, WritableVar } from "@/lib/types";

/** Instant commands that cut power or shut the UPS down, so they ask first. */
const RISKY = /^(load\.|shutdown\.|beeper\.disable)/;

function VariableRow({ hostId, upsId, variable }: { hostId: string; upsId: string; variable: WritableVar }) {
  const [value, setValue] = useState(variable.value);
  useEffect(() => setValue(variable.value), [variable.value]);
  const save = useAction(
    () => api.post(`/nut-hosts/${hostId}/ups/${upsId}/setvar`, { name: variable.name, value }),
    { invalidate: [["nut-controls", upsId]], success: `${variable.name} set` },
  );
  const range = variable.ranges?.[0];
  return (
    <div className="grid grid-cols-[1fr_10rem_auto] items-center gap-2">
      <span className="truncate font-mono text-xs" title={variable.name}>
        {variable.name}
      </span>
      {variable.type.kind === "enum" && variable.options?.length ? (
        <Select value={value} onValueChange={setValue}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {variable.options.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          inputMode={variable.type.kind === "string" ? "text" : "numeric"}
          placeholder={range ? `${range.min}-${range.max}` : undefined}
        />
      )}
      <Button
        size="sm"
        variant="outline"
        onClick={() => save.mutate(undefined)}
        disabled={value === variable.value || save.isPending}
      >
        Save
      </Button>
    </div>
  );
}

export function NutManageDialog({
  ups,
  host,
  onClose,
}: {
  ups: Ups | null;
  host: NutHost | null;
  onClose: () => void;
}) {
  const open = !!ups && !!host;
  const { data, isPending, error } = useQuery({
    queryKey: ["nut-controls", ups?.id],
    queryFn: () => api.get<UpsControls>(`/nut-hosts/${host!.id}/ups/${ups!.id}/controls`),
    enabled: open,
  });
  const run = useAction(
    (command: string) => api.post(`/nut-hosts/${host!.id}/ups/${ups!.id}/instcmd`, { command }),
    { success: "Command sent" },
  );
  const restart = useAction(() => api.post(`/nut-hosts/${host!.id}/service`, { action: "restart" }), {
    invalidate: [["nut-hosts"], ["ups"]],
    success: "NUT restarted",
  });
  const remove = useAction(() => api.delete(`/nut-hosts/${host!.id}/ups/${ups!.id}`), {
    invalidate: [["nut-hosts"], ["ups"], ["overview"]],
    success: "UPS removed from NUT",
  });

  const driver = host?.services?.drivers.find((d) => d.ups === ups?.upsName);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {ups?.name} on {host?.name}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
          <div className="flex items-center gap-2">
            Driver
            <ToneBadge tone={driver?.state === "running" ? "success" : driver ? "error" : "muted"}>
              {driver?.state ?? "unknown"}
            </ToneBadge>
          </div>
          <Button size="sm" variant="outline" onClick={() => restart.mutate(undefined)} disabled={restart.isPending}>
            <RotateCw className={restart.isPending ? "animate-spin" : ""} />
            Restart NUT
          </Button>
        </div>

        {isPending && <Loader2 className="text-muted-foreground mx-auto size-6 animate-spin" />}
        {error && <p className="text-destructive text-sm">{error.message}</p>}

        {data && (
          <ScrollArea className="max-h-[50vh] pr-3">
            <div className="grid gap-5">
              <section className="grid gap-2">
                <h3 className="text-sm font-medium">Instant commands</h3>
                {data.commands.length === 0 && <p className="text-muted-foreground text-sm">None</p>}
                <div className="flex flex-wrap gap-2">
                  {data.commands.map((command) =>
                    RISKY.test(command) ? (
                      <ConfirmAction
                        key={command}
                        title={`Run ${command}?`}
                        description="This can cut power to everything on this UPS."
                        confirmLabel="Run"
                        destructive
                        onConfirm={() => run.mutateAsync(command)}
                        trigger={
                          <Button size="sm" variant="outline" className="font-mono text-xs">
                            <Play />
                            {command}
                          </Button>
                        }
                      />
                    ) : (
                      <Button
                        key={command}
                        size="sm"
                        variant="outline"
                        className="font-mono text-xs"
                        onClick={() => run.mutate(command)}
                      >
                        <Play />
                        {command}
                      </Button>
                    ),
                  )}
                </div>
              </section>
              <section className="grid gap-2">
                <h3 className="text-sm font-medium">Settings</h3>
                {data.writable.length === 0 && <p className="text-muted-foreground text-sm">None</p>}
                {data.writable.map((variable) => (
                  <VariableRow key={variable.name} hostId={host!.id} upsId={ups!.id} variable={variable} />
                ))}
              </section>
            </div>
          </ScrollArea>
        )}

        <DialogFooter>
          <ConfirmAction
            title={`Remove ${ups?.name} from NUT?`}
            description="WolUPS removes the UPS from the host's NUT config and stops monitoring it."
            confirmLabel="Remove"
            destructive
            onConfirm={async () => {
              await remove.mutateAsync(undefined);
              onClose();
            }}
            trigger={
              <Button variant="outline" className="text-destructive">
                <Trash2 />
                Remove from NUT
              </Button>
            }
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
