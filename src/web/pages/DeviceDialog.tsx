import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Field, SwitchRow } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { useAction } from "@/lib/mutations";
import type { Device, Ups } from "@/lib/types";

type Form = {
  name: string;
  host: string;
  mac: string;
  upsId: string;
  shutdownEnabled: boolean;
  shutdownBatteryPercent: string;
  shutdownRuntimeSec: string;
  wakeEnabled: boolean;
  alwaysWake: boolean;
};

const NONE = "__none__";

function toForm(d?: Device): Form {
  return {
    name: d?.name ?? "",
    host: d?.host ?? "",
    mac: d?.mac ?? "",
    upsId: d?.upsId ?? NONE,
    shutdownEnabled: d?.shutdownEnabled ?? false,
    shutdownBatteryPercent: String(d?.shutdownBatteryPercent ?? 20),
    shutdownRuntimeSec: d?.shutdownRuntimeSec ? String(d.shutdownRuntimeSec) : "",
    wakeEnabled: d?.wakeEnabled ?? true,
    alwaysWake: d?.alwaysWake ?? false,
  };
}

export function DeviceDialog({
  open,
  onOpenChange,
  device,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  device?: Device;
}) {
  const [form, setForm] = useState<Form>(toForm());
  const { data: upsList = [] } = useQuery({ queryKey: ["ups"], queryFn: () => api.get<Ups[]>("/ups") });

  useEffect(() => {
    if (open) setForm(toForm(device));
  }, [open, device]);

  const set = (key: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value });

  const save = useAction(
    () => {
      const body = {
        name: form.name,
        host: form.host,
        mac: form.mac,
        upsId: form.upsId === NONE ? null : form.upsId,
        shutdownEnabled: form.shutdownEnabled,
        shutdownBatteryPercent: Number(form.shutdownBatteryPercent) || 20,
        shutdownRuntimeSec: form.shutdownRuntimeSec ? Number(form.shutdownRuntimeSec) : null,
        wakeEnabled: form.wakeEnabled,
        alwaysWake: form.alwaysWake,
      };
      return device ? api.patch(`/devices/${device.id}`, body) : api.post("/devices", body);
    },
    { invalidate: [["devices"], ["overview"]], success: device ? "Device updated" : "Device added" },
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{device ? "Edit device" : "Add device"}</DialogTitle>
        </DialogHeader>
        <form
          id="device-form"
          className="grid gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            await save.mutateAsync(undefined);
            onOpenChange(false);
          }}
        >
          <Field label="Name" htmlFor="dev-name">
            <Input id="dev-name" value={form.name} onChange={set("name")} placeholder="proxmox-1" required />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Host or IP" htmlFor="dev-host" help="Used for ping and relay subnet matching">
              <Input id="dev-host" value={form.host} onChange={set("host")} placeholder="192.168.1.20" />
            </Field>
            <Field label="MAC address" htmlFor="dev-mac" help="Needed for Wake-on-LAN">
              <Input id="dev-mac" value={form.mac} onChange={set("mac")} placeholder="aa:bb:cc:dd:ee:ff" />
            </Field>
          </div>
          <Field label="Powered by UPS">
            <Select value={form.upsId} onValueChange={(v) => setForm({ ...form, upsId: v })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>None</SelectItem>
                {upsList.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <SwitchRow label="Automatic shutdown" help="Requires a paired agent">
            <Switch
              checked={form.shutdownEnabled}
              onCheckedChange={(v) => setForm({ ...form, shutdownEnabled: v })}
            />
          </SwitchRow>
          {form.shutdownEnabled && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Shut down at battery %" htmlFor="dev-threshold">
                <Input
                  id="dev-threshold"
                  type="number"
                  min={1}
                  max={100}
                  value={form.shutdownBatteryPercent}
                  onChange={set("shutdownBatteryPercent")}
                />
              </Field>
              <Field label="Or at runtime below (s)" htmlFor="dev-runtime" help="Optional">
                <Input
                  id="dev-runtime"
                  type="number"
                  min={0}
                  value={form.shutdownRuntimeSec}
                  onChange={set("shutdownRuntimeSec")}
                  placeholder="300"
                />
              </Field>
            </div>
          )}

          <SwitchRow label="Wake after power returns">
            <Switch checked={form.wakeEnabled} onCheckedChange={(v) => setForm({ ...form, wakeEnabled: v })} />
          </SwitchRow>
          {form.wakeEnabled && (
            <SwitchRow label="Always wake" help="Wake even if it was offline before the outage">
              <Switch checked={form.alwaysWake} onCheckedChange={(v) => setForm({ ...form, alwaysWake: v })} />
            </SwitchRow>
          )}
        </form>
        <DialogFooter>
          <Button type="submit" form="device-form" disabled={save.isPending}>
            {device ? "Save" : "Add device"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
