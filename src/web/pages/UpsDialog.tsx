import { useEffect, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { Field } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { formatRuntime } from "@/lib/format";
import { useAction } from "@/lib/mutations";
import type { Ups, UpsSnapshot } from "@/lib/types";

type Form = { name: string; host: string; port: string; upsName: string; username: string; password: string };

const empty: Form = { name: "", host: "", port: "3493", upsName: "ups", username: "", password: "" };

export function UpsDialog({ open, onOpenChange, ups }: { open: boolean; onOpenChange: (o: boolean) => void; ups?: Ups }) {
  const [form, setForm] = useState<Form>(empty);
  const [testing, setTesting] = useState(false);
  const [found, setFound] = useState<{ name: string; description: string }[]>([]);

  useEffect(() => {
    if (!open) return;
    setFound([]);
    setForm(
      ups
        ? {
            name: ups.name,
            host: ups.host,
            port: String(ups.port),
            upsName: ups.upsName,
            username: ups.username ?? "",
            password: "",
          }
        : empty,
    );
  }, [open, ups]);

  const set = (key: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value });

  const connection = () => ({
    id: ups?.id,
    host: form.host,
    port: Number(form.port) || 3493,
    upsName: form.upsName,
    username: form.username || null,
    password: form.password || null,
  });

  const save = useAction(
    () => {
      const body = {
        name: form.name,
        host: form.host,
        port: Number(form.port) || 3493,
        upsName: form.upsName,
        username: form.username || null,
        ...(form.password ? { password: form.password } : {}),
      };
      return ups ? api.patch(`/ups/${ups.id}`, body) : api.post("/ups", body);
    },
    { invalidate: [["ups"], ["overview"]], success: ups ? "UPS updated" : "UPS added" },
  );

  async function test() {
    setTesting(true);
    try {
      const res = await api.post<{ ok: boolean; snapshot?: UpsSnapshot; error?: string }>("/ups/test", connection());
      if (res.ok && res.snapshot) {
        const s = res.snapshot;
        toast.success(`Connected: ${s.status}, ${s.battery ?? "?"}% battery, ${formatRuntime(s.runtime)} runtime`);
      } else toast.error(res.error ?? "Connection failed");
    } finally {
      setTesting(false);
    }
  }

  async function discover() {
    const res = await api.post<{ ok: boolean; ups: { name: string; description: string }[]; error?: string }>(
      "/ups/discover",
      connection(),
    );
    if (!res.ok) toast.error(res.error ?? "Could not list UPS units");
    else if (res.ups.length === 0) toast.info("The NUT server reports no UPS units");
    setFound(res.ups);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{ups ? "Edit UPS" : "Add UPS"}</DialogTitle>
        </DialogHeader>
        <form
          id="ups-form"
          className="grid gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            await save.mutateAsync(undefined);
            onOpenChange(false);
          }}
        >
          <Field label="Name" htmlFor="ups-name">
            <Input id="ups-name" value={form.name} onChange={set("name")} placeholder="Rack UPS" required />
          </Field>
          <div className="grid grid-cols-[1fr_6rem] gap-3">
            <Field label="NUT host" htmlFor="ups-host">
              <Input id="ups-host" value={form.host} onChange={set("host")} placeholder="192.168.1.10" required />
            </Field>
            <Field label="Port" htmlFor="ups-port">
              <Input id="ups-port" value={form.port} onChange={set("port")} inputMode="numeric" />
            </Field>
          </div>
          <Field label="UPS name in NUT" htmlFor="ups-upsname">
            <div className="flex gap-2">
              <Input id="ups-upsname" value={form.upsName} onChange={set("upsName")} required />
              <Button type="button" variant="outline" onClick={discover} disabled={!form.host}>
                <Search />
                Find
              </Button>
            </div>
            {found.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {found.map((f) => (
                  <Button
                    key={f.name}
                    type="button"
                    size="sm"
                    variant={f.name === form.upsName ? "secondary" : "outline"}
                    onClick={() => setForm({ ...form, upsName: f.name })}
                    title={f.description}
                  >
                    {f.name}
                  </Button>
                ))}
              </div>
            )}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Username" htmlFor="ups-user">
              <Input id="ups-user" value={form.username} onChange={set("username")} autoComplete="off" />
            </Field>
            <Field label="Password" htmlFor="ups-pass">
              <Input
                id="ups-pass"
                type="password"
                value={form.password}
                onChange={set("password")}
                placeholder={ups?.hasPassword ? "Unchanged" : ""}
                autoComplete="new-password"
              />
            </Field>
          </div>
        </form>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button type="button" variant="outline" onClick={test} disabled={testing || !form.host || !form.upsName}>
            {testing && <Loader2 className="animate-spin" />}
            Test connection
          </Button>
          <Button type="submit" form="ups-form" disabled={save.isPending}>
            {ups ? "Save" : "Add UPS"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
