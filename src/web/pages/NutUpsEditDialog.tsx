import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Field } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { ConfSection, NutHost } from "@/lib/types";

const CONF_VALUE = /^[A-Za-z0-9._:/@-]{1,128}$/;

export type EditTarget = { section: ConfSection; displayName: string; upsId: string | null };

/**
 * Edit a UPS WolUPS manages on a NUT host: its WolUPS name, and the description, port and serial in ups.conf. Only
 * changed keys are sent, so the rest of the section stays as written.
 */
export function NutUpsEditDialog({
  host,
  target,
  onClose,
  onSaved,
}: {
  host: NutHost | null;
  target: EditTarget | null;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState("");
  const [desc, setDesc] = useState("");
  const [port, setPort] = useState("");
  const [serial, setSerial] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!target) return;
    setDisplayName(target.displayName);
    setDesc(target.section.desc ?? "");
    setPort(target.section.port);
    setSerial(target.section.extra?.serial ?? "");
  }, [target]);

  const section = target?.section;
  const set: Record<string, string> = {};
  if (section && desc !== (section.desc ?? "")) set.desc = desc;
  if (section && port !== section.port) set.port = port;
  if (section && serial !== (section.extra?.serial ?? "")) set.serial = serial;
  const renamed = !!target && displayName.trim() !== target.displayName;
  const valid =
    !!displayName.trim() &&
    CONF_VALUE.test(port) &&
    (serial === "" || CONF_VALUE.test(serial)) &&
    !/["\\\n]/.test(desc);

  const save = async () => {
    if (!host || !target) return;
    setSaving(true);
    try {
      if (Object.keys(set).length > 0) {
        await api.post(`/nut-hosts/${host.id}/apply`, {
          ups: [],
          imported: [],
          edit: [{ name: target.section.name, displayName: displayName.trim(), set }],
          listen: host.listenAddress,
          localShutdown: host.localShutdown,
        });
      } else if (renamed && target.upsId) {
        // Only the WolUPS name changed, so NUT needs no restart.
        await api.patch(`/ups/${target.upsId}`, { name: displayName.trim() });
      }
      toast.success(`${displayName.trim()} saved`);
      queryClient.invalidateQueries({ queryKey: ["ups"] });
      queryClient.invalidateQueries({ queryKey: ["nut-hosts"] });
      onSaved?.();
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit {target?.section.name}</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field label="Display name" htmlFor="edit-name">
            <Input id="edit-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </Field>
          <Field label="Description" htmlFor="edit-desc">
            <Input id="edit-desc" value={desc} onChange={(e) => setDesc(e.target.value)} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Port" htmlFor="edit-port">
              <Input id="edit-port" value={port} onChange={(e) => setPort(e.target.value)} />
            </Field>
            <Field label="Serial" htmlFor="edit-serial">
              <Input id="edit-serial" value={serial} onChange={(e) => setSerial(e.target.value)} />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || saving || (!renamed && Object.keys(set).length === 0)}>
              {saving && <Loader2 className="animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
