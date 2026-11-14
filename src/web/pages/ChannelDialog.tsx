import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Eye, EyeOff, Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { CHANNEL_TYPES, CHANNEL_TYPE_IDS, type ChannelField, type ChannelType } from "@shared/channels";
import { DEFAULT_CHANNEL_EVENTS, EVENT_LABELS, EVENT_TYPES, TEMPLATE_VARIABLES, type EventType } from "@shared/events";
import { resolveTemplate } from "@shared/templates";
import { Field } from "@/components/common";
import { MultiCheck } from "@/components/MultiCheck";
import { TemplatePreview } from "@/components/TemplatePreview";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useAction } from "@/lib/mutations";
import type { AppSettings, Channel, Device, Ups } from "@/lib/types";

type Form = {
  name: string;
  type: ChannelType;
  config: Record<string, string>;
  events: EventType[];
  upsIds: string[];
  deviceIds: string[];
  titleTemplate: string;
  bodyTemplate: string;
};

function defaults(type: ChannelType): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of CHANNEL_TYPES[type].fields as ChannelField[]) if (f.default !== undefined) out[f.name] = String(f.default);
  return out;
}

function toForm(channel?: Channel): Form {
  if (!channel) {
    return {
      name: "",
      type: "discord",
      config: defaults("discord"),
      events: DEFAULT_CHANNEL_EVENTS,
      upsIds: [],
      deviceIds: [],
      titleTemplate: "",
      bodyTemplate: "",
    };
  }
  return {
    name: channel.name,
    type: channel.type,
    config: Object.fromEntries(Object.entries(channel.config).map(([k, v]) => [k, String(v)])),
    events: channel.events,
    upsIds: channel.upsIds ?? [],
    deviceIds: channel.deviceIds ?? [],
    titleTemplate: channel.titleTemplate ?? "",
    bodyTemplate: channel.bodyTemplate ?? "",
  };
}

function ConfigField({
  field,
  value,
  secretSet,
  onChange,
}: {
  field: ChannelField;
  value: string;
  secretSet: boolean;
  onChange: (v: string) => void;
}) {
  const id = `cfg-${field.name}`;
  const placeholder = field.secret && secretSet ? "Saved, leave empty to keep" : field.placeholder;
  let input;
  if (field.type === "select") {
    input = (
      <Select value={value || String(field.default ?? "")} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {field.options?.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  } else if (field.type === "textarea") {
    input = <Textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />;
  } else {
    const type = field.secret ? "password" : field.type === "number" ? "number" : field.type === "email" ? "email" : "text";
    input = (
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={field.required && !(field.secret && secretSet)}
        autoComplete="off"
      />
    );
  }
  return (
    <Field label={field.label} htmlFor={id} help={field.help}>
      {input}
    </Field>
  );
}

export function ChannelDialog({
  open,
  onOpenChange,
  channel,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  channel?: Channel;
}) {
  const [form, setForm] = useState<Form>(toForm());
  const [testing, setTesting] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewEvent, setPreviewEvent] = useState<EventType | null>(null);
  const { data: upsList = [] } = useQuery({ queryKey: ["ups"], queryFn: () => api.get<Ups[]>("/ups"), enabled: open });
  const { data: deviceList = [] } = useQuery({
    queryKey: ["devices"],
    queryFn: () => api.get<Device[]>("/devices"),
    enabled: open,
  });

  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.get<{ settings: AppSettings }>("/settings"),
    enabled: open && previewing,
  });

  useEffect(() => {
    if (open) setForm(toForm(channel));
  }, [open, channel]);

  // Preview with the channel's own events; fall back to all of them when none are picked.
  const previewEvents = form.events.length ? form.events : EVENT_TYPES.filter((t) => t !== "test");
  const previewType = previewEvent && previewEvents.includes(previewEvent) ? previewEvent : previewEvents[0];
  const previewTemplate = resolveTemplate(previewType, settings?.settings.templates ?? {}, form);

  const fields = CHANNEL_TYPES[form.type].fields as ChannelField[];
  const secretsSet = channel && channel.type === form.type ? channel.secretsSet : {};

  const payload = () => ({
    name: form.name,
    type: form.type,
    config: form.config,
    events: form.events,
    upsIds: form.upsIds,
    deviceIds: form.deviceIds,
    titleTemplate: form.titleTemplate || null,
    bodyTemplate: form.bodyTemplate || null,
  });

  const save = useAction(
    () => (channel ? api.patch(`/channels/${channel.id}`, payload()) : api.post("/channels", payload())),
    { invalidate: [["channels"]], success: channel ? "Channel saved" : "Channel added" },
  );

  async function test() {
    setTesting(true);
    try {
      const res = await api.post<{ ok: boolean; error?: string }>("/channels/test", { ...payload(), id: channel?.id });
      if (res.ok) toast.success("Test notification sent");
      else toast.error(res.error ?? "Test failed");
    } finally {
      setTesting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{channel ? "Edit channel" : "Add channel"}</DialogTitle>
        </DialogHeader>
        <form
          id="channel-form"
          onSubmit={async (e) => {
            e.preventDefault();
            await save.mutateAsync(undefined);
            onOpenChange(false);
          }}
        >
          <Tabs defaultValue="connection">
            <TabsList className="mb-4">
              <TabsTrigger value="connection">Connection</TabsTrigger>
              <TabsTrigger value="events">Events</TabsTrigger>
              <TabsTrigger value="message">Message</TabsTrigger>
            </TabsList>

            <TabsContent value="connection" forceMount className="grid gap-4 data-[state=inactive]:hidden">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Name" htmlFor="ch-name">
                  <Input
                    id="ch-name"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="Phone"
                    required
                  />
                </Field>
                <Field label="Type">
                  <Select
                    value={form.type}
                    onValueChange={(v) => setForm({ ...form, type: v as ChannelType, config: defaults(v as ChannelType) })}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CHANNEL_TYPE_IDS.map((t) => (
                        <SelectItem key={t} value={t}>
                          {CHANNEL_TYPES[t].label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              {fields.map((f) => (
                <ConfigField
                  key={`${form.type}-${f.name}`}
                  field={f}
                  value={form.config[f.name] ?? ""}
                  secretSet={!!secretsSet[f.name]}
                  onChange={(v) => setForm({ ...form, config: { ...form.config, [f.name]: v } })}
                />
              ))}
            </TabsContent>

            <TabsContent value="events" forceMount className="grid gap-5 data-[state=inactive]:hidden">
              <Field label="Notify on">
                <MultiCheck
                  options={EVENT_TYPES.filter((t) => t !== "test").map((t) => ({ value: t, label: EVENT_LABELS[t] }))}
                  value={form.events}
                  onChange={(v) => setForm({ ...form, events: v as EventType[] })}
                />
              </Field>
              {upsList.length > 0 && (
                <Field label="Only these UPS" help="Leave all unchecked for every UPS">
                  <MultiCheck
                    options={upsList.map((u) => ({ value: u.id, label: u.name }))}
                    value={form.upsIds}
                    onChange={(v) => setForm({ ...form, upsIds: v })}
                  />
                </Field>
              )}
              {deviceList.length > 0 && (
                <Field label="Only these devices" help="Leave all unchecked for every device">
                  <MultiCheck
                    options={deviceList.map((d) => ({ value: d.id, label: d.name }))}
                    value={form.deviceIds}
                    onChange={(v) => setForm({ ...form, deviceIds: v })}
                  />
                </Field>
              )}
            </TabsContent>

            <TabsContent value="message" forceMount className="grid gap-4 data-[state=inactive]:hidden">
              <Field label="Title template" htmlFor="ch-title" help="Empty uses the global template">
                <Input
                  id="ch-title"
                  value={form.titleTemplate}
                  onChange={(e) => setForm({ ...form, titleTemplate: e.target.value })}
                  placeholder="{title}"
                />
              </Field>
              <Field label="Body template" htmlFor="ch-body">
                <Textarea
                  id="ch-body"
                  value={form.bodyTemplate}
                  onChange={(e) => setForm({ ...form, bodyTemplate: e.target.value })}
                  placeholder="{message}"
                  rows={4}
                />
              </Field>
              <div className="flex items-start justify-between gap-3">
                <p className="text-muted-foreground text-xs">
                  Variables: {TEMPLATE_VARIABLES.map((v) => `{${v}}`).join(" ")}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setPreviewing(!previewing)}
                  aria-pressed={previewing}
                >
                  {previewing ? <EyeOff /> : <Eye />}
                  Preview
                </Button>
              </div>
              {previewing && (
                <div className="grid gap-2">
                  <Select value={previewType} onValueChange={(v) => setPreviewEvent(v as EventType)}>
                    <SelectTrigger className="w-full" aria-label="Preview event">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {previewEvents.map((t) => (
                        <SelectItem key={t} value={t}>
                          {EVENT_LABELS[t]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <TemplatePreview eventType={previewType} template={previewTemplate} />
                </div>
              )}
            </TabsContent>
          </Tabs>
        </form>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button type="button" variant="outline" onClick={test} disabled={testing}>
            {testing ? <Loader2 className="animate-spin" /> : <Send />}
            Send test
          </Button>
          <Button type="submit" form="channel-form" disabled={save.isPending}>
            {channel ? "Save" : "Add channel"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
