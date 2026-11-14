import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { DEFAULT_TEMPLATE, EVENT_LABELS, EVENT_TYPES, TEMPLATE_VARIABLES, type EventType } from "@shared/events";
import { Field } from "@/components/common";
import { TemplatePreview } from "@/components/TemplatePreview";
import { TimeSettings } from "@/components/TimeSettings";
import { WAKE_DELIVERY_KEY, WakeDeliveryStatus } from "@/components/WakeDeliveryStatus";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { formatDateTime } from "@/lib/format";
import { useAction } from "@/lib/mutations";
import type { AppSettings, SystemInfo } from "@/lib/types";

type SettingsResponse = { settings: AppSettings; system: SystemInfo };

function NumberField({
  label,
  value,
  onChange,
  help,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  help?: string;
  min?: number;
  max?: number;
}) {
  const id = label.toLowerCase().replace(/\W+/g, "-");
  return (
    <Field label={label} htmlFor={id} help={help}>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </Field>
  );
}

function GeneralTab({ data, onSave }: { data: SettingsResponse; onSave: (p: Partial<AppSettings>) => Promise<unknown> }) {
  const [s, setS] = useState(data.settings);
  useEffect(() => setS(data.settings), [data.settings]);
  const check = useAction(() => api.post<SystemInfo>("/settings/check-agent-release"), {
    invalidate: [["settings"], ["devices"]],
    success: (r) => (r.latestAgentError ? null : `Latest agent: v${r.latestAgent?.version ?? "none published"}`),
  });
  const sys = data.system;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Monitoring</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <NumberField
            label="UPS poll interval (s)"
            value={s.pollIntervalSec}
            min={2}
            max={300}
            onChange={(v) => setS({ ...s, pollIntervalSec: v })}
          />
          <NumberField
            label="Chart sample interval (s)"
            value={s.sampleIntervalSec}
            min={10}
            onChange={(v) => setS({ ...s, sampleIntervalSec: v })}
          />
          <NumberField
            label="Device ping interval (s)"
            value={s.devicePingIntervalSec}
            min={5}
            onChange={(v) => setS({ ...s, devicePingIntervalSec: v })}
          />
          <NumberField
            label="Agent update check (minutes)"
            value={s.agentUpdateCheckMinutes}
            min={5}
            max={1440}
            onChange={(v) => setS({ ...s, agentUpdateCheckMinutes: v })}
          />
          <NumberField
            label="Keep events (days)"
            value={s.eventRetentionDays}
            min={1}
            onChange={(v) => setS({ ...s, eventRetentionDays: v })}
          />
          <NumberField
            label="Keep chart data (days)"
            value={s.sampleRetentionDays}
            min={1}
            max={365}
            onChange={(v) => setS({ ...s, sampleRetentionDays: v })}
          />
        </CardContent>
        <CardFooter>
          <Button onClick={() => onSave(s)}>Save</Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Server</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 text-sm">
            {[
              ["Base URL", sys.baseUrl],
              ["Version", sys.commit ? `v${sys.version} (${sys.commit})` : `v${sys.version}`],
              ["Time zone", sys.timezone],
              ["Agent releases", sys.agentRepo],
              [
                "Latest agent",
                sys.latestAgentError
                  ? `Check failed: ${sys.latestAgentError}`
                  : sys.latestAgent
                    ? `v${sys.latestAgent.version} (checked ${formatDateTime(sys.latestAgent.checkedAt)})`
                    : "Not checked yet",
              ],
            ].map(([k, v]) => (
              <div key={k} className="grid grid-cols-[8rem_1fr] gap-2">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="font-mono text-xs break-all">{v}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
        <CardFooter>
          <Button variant="outline" onClick={() => check.mutate(undefined)} disabled={check.isPending}>
            <RefreshCw className={check.isPending ? "animate-spin" : ""} />
            Check agent release
          </Button>
        </CardFooter>
      </Card>

      <TimeSettings
        time={data.settings.time}
        serverTimezone={sys.timezone}
        onSave={(time) => onSave({ time })}
      />
    </div>
  );
}

function WakeTab({ data, onSave }: { data: SettingsResponse; onSave: (p: Partial<AppSettings>) => Promise<unknown> }) {
  const queryClient = useQueryClient();
  const [s, setS] = useState(data.settings);
  useEffect(() => setS(data.settings), [data.settings]);
  const wake = s.wake;
  const setWake = (patch: Partial<AppSettings["wake"]>) => setS({ ...s, wake: { ...wake, ...patch } });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>After power returns</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <NumberField
            label="Restore delay (s)"
            value={wake.restoreDelaySec}
            min={0}
            onChange={(v) => setWake({ restoreDelaySec: v })}
          />
          <NumberField
            label="Minimum battery (%)"
            value={wake.minBatteryPercent}
            min={0}
            max={100}
            onChange={(v) => setWake({ minBatteryPercent: v })}
          />
          <NumberField
            label="Give up after (s)"
            value={wake.clientTimeoutSec}
            min={30}
            onChange={(v) => setWake({ clientTimeoutSec: v })}
          />
          <NumberField
            label="Retry wake every (s)"
            value={wake.reattemptDelaySec}
            min={5}
            onChange={(v) => setWake({ reattemptDelaySec: v })}
          />
        </CardContent>
        <CardFooter>
          <Button onClick={() => onSave({ wake })}>Save</Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Wake-on-LAN delivery</CardTitle>
          <CardAction>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => queryClient.invalidateQueries({ queryKey: WAKE_DELIVERY_KEY })}
            >
              <RefreshCw />
              Test
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Field label="Send wake packets from">
            <Select value={s.wolMode} onValueChange={(v) => setS({ ...s, wolMode: v as AppSettings["wolMode"] })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Server and a relay agent</SelectItem>
                <SelectItem value="server">Server only</SelectItem>
                <SelectItem value="agent">Relay agent only</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Server broadcast address" htmlFor="wol-bcast">
            <Input id="wol-bcast" value={s.wolBroadcast} onChange={(e) => setS({ ...s, wolBroadcast: e.target.value })} />
          </Field>
          <div className="border-t pt-4">
            <WakeDeliveryStatus />
          </div>
        </CardContent>
        <CardFooter>
          <Button
            onClick={async () => {
              await onSave({ wolMode: s.wolMode, wolBroadcast: s.wolBroadcast });
              queryClient.invalidateQueries({ queryKey: WAKE_DELIVERY_KEY });
            }}
          >
            Save
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}

function TemplatesTab({ data, onSave }: { data: SettingsResponse; onSave: (p: Partial<AppSettings>) => Promise<unknown> }) {
  const [templates, setTemplates] = useState(data.settings.templates);
  useEffect(() => setTemplates(data.settings.templates), [data.settings.templates]);
  const [previewing, setPreviewing] = useState<EventType[]>([]);
  const types = EVENT_TYPES.filter((t) => t !== "test");

  const togglePreview = (type: EventType) =>
    setPreviewing((p) => (p.includes(type) ? p.filter((t) => t !== type) : [...p, type]));

  const update = (type: string, key: "title" | "body", value: string) => {
    const current = templates[type] ?? DEFAULT_TEMPLATE;
    setTemplates({ ...templates, [type]: { ...current, [key]: value } });
  };

  const save = () => {
    // Drop templates equal to the default so they follow future default changes.
    const cleaned = Object.fromEntries(
      Object.entries(templates).filter(([, t]) => t.title !== DEFAULT_TEMPLATE.title || t.body !== DEFAULT_TEMPLATE.body),
    );
    return onSave({ templates: cleaned });
  };

  return (
    <Card>
      <CardHeader>
        <CardDescription>Variables: {TEMPLATE_VARIABLES.map((v) => `{${v}}`).join(" ")}</CardDescription>
      </CardHeader>
      <CardContent className="divide-y">
        {types.map((type) => {
          const t = templates[type] ?? DEFAULT_TEMPLATE;
          const open = previewing.includes(type);
          return (
            <div key={type} className="grid gap-3 py-4 first:pt-0 md:grid-cols-[12rem_1fr_2fr_auto]">
              <p className="pt-2 text-sm font-medium">{EVENT_LABELS[type]}</p>
              <Input value={t.title} onChange={(e) => update(type, "title", e.target.value)} aria-label="Title" />
              <Textarea
                value={t.body}
                onChange={(e) => update(type, "body", e.target.value)}
                rows={1}
                className="min-h-9"
                aria-label="Body"
              />
              <Button
                variant="outline"
                onClick={() => togglePreview(type)}
                aria-pressed={open}
                className="justify-self-start"
              >
                {open ? <EyeOff /> : <Eye />}
                Preview
              </Button>
              {open && <TemplatePreview eventType={type} template={t} className="md:col-start-2 md:col-end-4" />}
            </div>
          );
        })}
      </CardContent>
      <CardFooter>
        <Button onClick={save}>Save templates</Button>
      </CardFooter>
    </Card>
  );
}

function AccountTab() {
  const { data: session, refetch } = authClient.useSession();
  const [name, setName] = useState("");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  useEffect(() => setName(session?.user.name ?? ""), [session?.user.name]);

  async function saveName() {
    const { error } = await authClient.updateUser({ name });
    if (error) toast.error(error.message ?? "Could not update");
    else {
      toast.success("Name updated");
      refetch();
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await authClient.changePassword({
      currentPassword: current,
      newPassword: next,
      revokeOtherSessions: true,
    });
    if (error) toast.error(error.message ?? "Could not change password");
    else {
      toast.success("Password changed, other sessions signed out");
      setCurrent("");
      setNext("");
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Field label="Name" htmlFor="acc-name">
            <Input id="acc-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Email" htmlFor="acc-email">
            <Input id="acc-email" value={session?.user.email ?? ""} disabled />
          </Field>
        </CardContent>
        <CardFooter>
          <Button onClick={saveName}>Save</Button>
        </CardFooter>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Password</CardTitle>
        </CardHeader>
        <form onSubmit={changePassword}>
          <CardContent className="grid gap-4">
            <Field label="Current password" htmlFor="acc-current">
              <Input
                id="acc-current"
                type="password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                autoComplete="current-password"
                required
              />
            </Field>
            <Field label="New password" htmlFor="acc-new" help="At least 8 characters">
              <Input
                id="acc-new"
                type="password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                minLength={8}
                autoComplete="new-password"
                required
              />
            </Field>
          </CardContent>
          <CardFooter className="pt-6">
            <Button type="submit">Change password</Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}

export function SettingsPage() {
  const { data } = useQuery({ queryKey: ["settings"], queryFn: () => api.get<SettingsResponse>("/settings") });
  const save = useAction((patch: Partial<AppSettings>) => api.patch<SettingsResponse>("/settings", patch), {
    invalidate: [["settings"]],
    success: "Settings saved",
  });
  const onSave = (patch: Partial<AppSettings>) => save.mutateAsync(patch);

  return (
    <Tabs defaultValue="general">
      <TabsList className="mb-2">
        <TabsTrigger value="general">General</TabsTrigger>
        <TabsTrigger value="wake">Wake</TabsTrigger>
        <TabsTrigger value="templates">Templates</TabsTrigger>
        <TabsTrigger value="account">Account</TabsTrigger>
      </TabsList>
      {data && (
        <>
          <TabsContent value="general">
            <GeneralTab data={data} onSave={onSave} />
          </TabsContent>
          <TabsContent value="wake">
            <WakeTab data={data} onSave={onSave} />
          </TabsContent>
          <TabsContent value="templates">
            <TemplatesTab data={data} onSave={onSave} />
          </TabsContent>
        </>
      )}
      <TabsContent value="account">
        <AccountTab />
      </TabsContent>
    </Tabs>
  );
}
