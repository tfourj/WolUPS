import { useMemo } from "react";
import type { TimeFormat, TimePreferences, TimeStyle } from "@shared/time";
import { Field } from "@/components/common";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatDateTime } from "@/lib/format";

/** Select value for "no timezone chosen". Radix Select does not allow an empty value. */
const DEFAULT_ZONE = "default";

const TIME_FORMAT_LABELS: Record<TimeFormat, string> = {
  auto: "Automatic",
  "12h": "12-hour (7:00 PM)",
  "24h": "24-hour (19:00)",
};

const TIME_STYLE_LABELS: Record<TimeStyle, string> = {
  relative: "Relative (5 minutes ago)",
  absolute: "Date and time",
};

function browserTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function timeZones(current: string | null) {
  const zones = new Set(Intl.supportedValuesOf("timeZone"));
  zones.add("UTC");
  if (current) zones.add(current);
  return [...zones].sort();
}

export function TimeSettings({
  time,
  serverTimezone,
  onSave,
}: {
  time: TimePreferences;
  serverTimezone: string;
  onSave: (time: TimePreferences) => Promise<unknown>;
}) {
  const zones = useMemo(() => timeZones(time.timezone), [time.timezone]);
  const update = (patch: Partial<TimePreferences>) => onSave({ ...time, ...patch });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Time display</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <Field
          label="Timezone"
          htmlFor="time-zone"
          help={
            time.timezone === null
              ? `The app uses your browser (${browserTimeZone()}). Notifications use the server (${serverTimezone}).`
              : undefined
          }
        >
          <Select
            value={time.timezone ?? DEFAULT_ZONE}
            onValueChange={(v) => update({ timezone: v === DEFAULT_ZONE ? null : v })}
          >
            <SelectTrigger id="time-zone" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_ZONE}>Default</SelectItem>
              {zones.map((zone) => (
                <SelectItem key={zone} value={zone}>
                  {zone.replaceAll("_", " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          <Field label="Clock" htmlFor="time-format" className="min-w-0">
            <Select value={time.timeFormat} onValueChange={(v) => update({ timeFormat: v as TimeFormat })}>
              <SelectTrigger id="time-format" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(TIME_FORMAT_LABELS) as TimeFormat[]).map((format) => (
                  <SelectItem key={format} value={format}>
                    {TIME_FORMAT_LABELS[format]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Recent times" htmlFor="time-style" className="min-w-0">
            <Select value={time.timeStyle} onValueChange={(v) => update({ timeStyle: v as TimeStyle })}>
              <SelectTrigger id="time-style" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(TIME_STYLE_LABELS) as TimeStyle[]).map((style) => (
                  <SelectItem key={style} value={style}>
                    {TIME_STYLE_LABELS[style]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <p className="text-muted-foreground text-xs">Now: {formatDateTime(new Date())}</p>
      </CardContent>
    </Card>
  );
}
