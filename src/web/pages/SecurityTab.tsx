import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Download, LogOut, Monitor, Send, Smartphone } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { encode } from "uqr";
import { CHANNEL_TYPES } from "@shared/channels";
import { Field, ToneBadge } from "@/components/common";
import { ConfirmAction } from "@/components/confirm";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { formatDateTime, timeAgo } from "@/lib/format";
import type { Channel, LoginTestResult, SecurityStatus, SignedInDevice } from "@/lib/types";

export const SECURITY_KEY = ["security"];

/** QR code drawn as one SVG path. Always dark on white so every scanner can read it. */
function QrCode({ value }: { value: string }) {
  const { path, size } = useMemo(() => {
    const qr = encode(value, { border: 2 });
    let d = "";
    qr.data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return { path: d, size: qr.size };
  }, [value]);

  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="size-44 rounded-md bg-white" shapeRendering="crispEdges">
      <path d={path} fill="#000" />
    </svg>
  );
}

function BackupCodes({ codes }: { codes: string[] }) {
  const text = codes.join("\n");

  function download() {
    const url = URL.createObjectURL(new Blob([`WolUPS backup codes\n\n${text}\n`], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "wolups-backup-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function copy() {
    await navigator.clipboard.writeText(text);
    toast.success("Backup codes copied");
  }

  return (
    <div className="grid gap-3">
      <div className="bg-muted/40 grid grid-cols-2 gap-x-6 gap-y-1 rounded-md border p-3 font-mono text-sm">
        {codes.map((code) => (
          <span key={code}>{code}</span>
        ))}
      </div>
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          <Copy />
          Copy
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={download}>
          <Download />
          Download
        </Button>
      </div>
    </div>
  );
}

function PasswordField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <Field label="Password" htmlFor="2fa-password">
      <Input
        id="2fa-password"
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="current-password"
        required
        autoFocus
      />
    </Field>
  );
}

type EnableStep =
  | { step: "password" }
  | { step: "scan"; totpURI: string; backupCodes: string[] }
  | { step: "codes"; backupCodes: string[] };

function EnableDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<EnableStep>({ step: "password" });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setState({ step: "password" });
    setPassword("");
    setCode("");
  }, [open]);

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { data, error } = await authClient.twoFactor.enable({ password });
    setBusy(false);
    if (error || !data || !("totpURI" in data)) {
      toast.error(error?.message ?? "Could not start setup");
      return;
    }
    setPassword("");
    setState({ step: "scan", totpURI: data.totpURI, backupCodes: data.backupCodes });
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    if (state.step !== "scan") return;
    setBusy(true);
    const { error } = await authClient.twoFactor.verifyTotp({ code: code.replace(/\s+/g, "") });
    setBusy(false);
    if (error) {
      toast.error(error.message ?? "Invalid code");
      return;
    }
    queryClient.invalidateQueries({ queryKey: SECURITY_KEY });
    setState({ step: "codes", backupCodes: state.backupCodes });
  }

  const secret = state.step === "scan" ? new URL(state.totpURI).searchParams.get("secret") : null;
  // A stray click or Escape during the scan step would lose the QR code; only the buttons close it.
  const keepOpen = (e: Event) => state.step === "scan" && e.preventDefault();

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" onInteractOutside={keepOpen} onEscapeKeyDown={keepOpen}>
        <DialogHeader>
          <DialogTitle>{state.step === "codes" ? "Save your backup codes" : "Set up two-factor authentication"}</DialogTitle>
          {state.step === "scan" && (
            <DialogDescription>
              Scan the code with an authenticator app, then enter the 6-digit code it shows.
            </DialogDescription>
          )}
          {state.step === "codes" && (
            <DialogDescription>
              Each code works once. Use one to sign in if you lose access to your authenticator app.
            </DialogDescription>
          )}
        </DialogHeader>

        {state.step === "password" && (
          <form onSubmit={submitPassword} className="grid gap-4">
            <PasswordField value={password} onChange={setPassword} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                Continue
              </Button>
            </DialogFooter>
          </form>
        )}

        {state.step === "scan" && (
          <form onSubmit={submitCode} className="grid gap-4">
            <div className="flex flex-col items-center gap-2">
              <QrCode value={state.totpURI} />
              {secret && (
                <code className="bg-muted rounded px-2 py-1 font-mono text-xs break-all select-all">{secret}</code>
              )}
            </div>
            <Field label="Code" htmlFor="2fa-code">
              <Input
                id="2fa-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="123456"
                required
                autoFocus
              />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                Turn on
              </Button>
            </DialogFooter>
          </form>
        )}

        {state.step === "codes" && (
          <>
            <BackupCodes codes={state.backupCodes} />
            <DialogFooter>
              <Button onClick={onClose}>Done</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DisableDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setPassword("");
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await authClient.twoFactor.disable({ password });
    setBusy(false);
    if (error) {
      toast.error(error.message ?? "Could not turn off two-factor authentication");
      return;
    }
    queryClient.invalidateQueries({ queryKey: SECURITY_KEY });
    toast.success("Two-factor authentication is off");
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Turn off two-factor authentication</DialogTitle>
            <DialogDescription>Signing in will only need your password. Trusted devices are forgotten.</DialogDescription>
          </DialogHeader>
          <PasswordField value={password} onChange={setPassword} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={busy}>
              Turn off
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NewCodesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPassword("");
    setCodes(null);
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { data, error } = await authClient.twoFactor.generateBackupCodes({ password });
    setBusy(false);
    if (error || !data) {
      toast.error(error?.message ?? "Could not create backup codes");
      return;
    }
    setCodes(data.backupCodes);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New backup codes</DialogTitle>
          <DialogDescription>
            {codes ? "Your old codes no longer work." : "Your current backup codes will stop working."}
          </DialogDescription>
        </DialogHeader>
        {codes ? (
          <>
            <BackupCodes codes={codes} />
            <DialogFooter>
              <Button onClick={onClose}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="grid gap-4">
            <PasswordField value={password} onChange={setPassword} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                Create codes
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

type DialogName = "enable" | "disable" | "codes";

function TwoFactorCard({ status }: { status: SecurityStatus }) {
  const [dialog, setDialog] = useState<DialogName | null>(null);
  const close = () => setDialog(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Two-factor authentication
          <ToneBadge tone={status.twoFactorEnabled ? "success" : "muted"}>
            {status.twoFactorEnabled ? "On" : "Off"}
          </ToneBadge>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {status.twoFactorEnabled ? (
          <>
            <Button variant="outline" onClick={() => setDialog("codes")}>
              New backup codes
            </Button>
            <Button variant="outline" onClick={() => setDialog("disable")}>
              Turn off
            </Button>
          </>
        ) : (
          <Button onClick={() => setDialog("enable")}>Set up</Button>
        )}
      </CardContent>
      <EnableDialog open={dialog === "enable"} onClose={close} />
      <DisableDialog open={dialog === "disable"} onClose={close} />
      <NewCodesDialog open={dialog === "codes"} onClose={close} />
    </Card>
  );
}

function sameIds(a: string[], b: string[]) {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/** Picks the channels subscribed to "login" events. Same setting as the event list in each channel. */
function LoginNotificationsCard({ status }: { status: SecurityStatus }) {
  const queryClient = useQueryClient();
  const { data: channels = [], isPending } = useQuery({
    queryKey: ["channels"],
    queryFn: () => api.get<Channel[]>("/channels"),
  });
  const saved = status.loginChannelIds;
  const [selected, setSelected] = useState<string[]>(saved);
  // Reset only when the saved ids change, not on every refetch.
  useEffect(() => setSelected(saved), [saved.join(",")]);

  const save = useMutation({
    mutationFn: () => api.patch<SecurityStatus>("/security/login-channels", { channelIds: selected }),
    onSuccess: (next) => {
      queryClient.setQueryData(SECURITY_KEY, next);
      queryClient.invalidateQueries({ queryKey: ["channels"] });
      toast.success(next.loginChannelIds.length ? "Login notifications saved" : "Login notifications turned off");
    },
    onError: (error) => toast.error(error.message),
  });
  const test = useMutation({
    mutationFn: () => api.post<LoginTestResult>("/security/login-channels/test", { channelIds: selected }),
    onSuccess: ({ results }) => {
      for (const r of results) {
        if (r.ok) toast.success(`Test sent to ${r.name}`);
        else toast.error(`${r.name}: ${r.error}`);
      }
    },
    onError: (error) => toast.error(error.message),
  });

  const toggle = (id: string, on: boolean) =>
    setSelected((ids) => (on ? [...new Set([...ids, id])] : ids.filter((x) => x !== id)));
  const dirty = !sameIds(selected, saved);
  const canTest = channels.some((c) => c.enabled && selected.includes(c.id));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Login notifications
          <ToneBadge tone={saved.length ? "success" : "muted"}>{saved.length ? "On" : "Off"}</ToneBadge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isPending ? null : channels.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No channels yet.{" "}
            <Link to="/channels" className="text-foreground font-medium underline-offset-4 hover:underline">
              Add a channel
            </Link>{" "}
            to get notified of new sign-ins.
          </p>
        ) : (
          <div className="grid gap-2">
            {channels.map((channel) => (
              <label key={channel.id} className="flex items-center gap-3 rounded-lg border px-3 py-2 text-sm">
                <Checkbox
                  checked={selected.includes(channel.id)}
                  onCheckedChange={(v) => toggle(channel.id, v === true)}
                />
                <span className="min-w-0 flex-1 truncate font-medium">{channel.name}</span>
                {!channel.enabled && <ToneBadge tone="muted">Disabled</ToneBadge>}
                <span className="text-muted-foreground text-xs">{CHANNEL_TYPES[channel.type]?.label ?? channel.type}</span>
              </label>
            ))}
          </div>
        )}
      </CardContent>
      {channels.length > 0 && (
        <CardFooter className="flex justify-end gap-2">
          <Button variant="outline" disabled={!canTest || test.isPending} onClick={() => test.mutate()}>
            <Send />
            Send test
          </Button>
          <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}

const DEVICES_KEY = ["security", "sessions"];

/** Every device signed in to the account, with a way to sign out some or all of them. */
function DevicesCard() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: devices = [] } = useQuery({
    queryKey: DEVICES_KEY,
    queryFn: () => api.get<SignedInDevice[]>("/security/sessions"),
  });
  const [selected, setSelected] = useState<string[]>([]);
  // Devices that signed out elsewhere drop out of the selection.
  const picked = selected.filter((id) => devices.some((d) => d.id === id && !d.current));

  const revoke = useMutation({
    mutationFn: () => api.post<SignedInDevice[]>("/security/sessions/revoke", { ids: picked }),
    onSuccess: (next) => {
      queryClient.setQueryData(DEVICES_KEY, next);
      toast.success(picked.length === 1 ? "Device signed out" : `${picked.length} devices signed out`);
      setSelected([]);
    },
    onError: (error) => toast.error(error.message),
  });

  async function signOutAll() {
    try {
      await api.post("/security/sessions/revoke-all");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not sign out");
      return;
    }
    // The session is already gone; this only clears the cookie and the cached session.
    await authClient.signOut().catch(() => null);
    navigate("/login");
  }

  const toggle = (id: string, on: boolean) =>
    setSelected((ids) => (on ? [...new Set([...ids, id])] : ids.filter((x) => x !== id)));

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Devices
          <ToneBadge tone="muted">{devices.length}</ToneBadge>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2">
        {devices.map((device) => {
          const Icon = /iOS|Android/.test(device.name) ? Smartphone : Monitor;
          return (
            <label key={device.id} className="flex items-center gap-3 rounded-lg border px-3 py-2 text-sm">
              <Checkbox
                checked={picked.includes(device.id)}
                disabled={device.current}
                onCheckedChange={(v) => toggle(device.id, v === true)}
              />
              <Icon className="text-muted-foreground size-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium" title={device.userAgent ?? undefined}>
                    {device.name}
                  </span>
                  {device.current && <ToneBadge tone="success">This device</ToneBadge>}
                </div>
                <div className="text-muted-foreground flex flex-wrap gap-x-3 text-xs">
                  <span className="font-mono">{device.ip ?? "Unknown IP"}</span>
                  <span title={formatDateTime(device.lastActiveAt)}>Last active {timeAgo(device.lastActiveAt)}</span>
                  <span>Signed in {formatDateTime(device.signedInAt)}</span>
                </div>
              </div>
            </label>
          );
        })}
      </CardContent>
      <CardFooter className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" disabled={picked.length === 0 || revoke.isPending} onClick={() => revoke.mutate()}>
          <LogOut />
          Sign out selected
        </Button>
        <ConfirmAction
          trigger={<Button variant="destructive">Sign out all</Button>}
          title="Sign out of all devices?"
          description="Every device is signed out, including this one. You will need to sign in again."
          confirmLabel="Sign out all"
          destructive
          onConfirm={signOutAll}
        />
      </CardFooter>
    </Card>
  );
}

export function SecurityTab() {
  const { data } = useQuery({ queryKey: SECURITY_KEY, queryFn: () => api.get<SecurityStatus>("/security") });
  if (!data) return null;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <TwoFactorCard status={data} />
      <LoginNotificationsCard status={data} />
      <DevicesCard />
    </div>
  );
}
