import { useQuery } from "@tanstack/react-query";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "@/lib/api";
import { formatDateTime, withTimePreferences } from "@/lib/format";
import type { Sample } from "@/lib/types";

const RANGE_HOURS: Record<string, number> = { "6h": 6, "24h": 24, "7d": 168, "30d": 720 };

function tickFormatter(range: string) {
  return (value: number) => {
    const d = new Date(value);
    return RANGE_HOURS[range] > 24
      ? d.toLocaleDateString(undefined, withTimePreferences({ month: "short", day: "numeric" }))
      : d.toLocaleTimeString(undefined, withTimePreferences({ hour: "2-digit", minute: "2-digit" }));
  };
}

export function BatteryChart({ upsId, range }: { upsId: string; range: string }) {
  const { data = [] } = useQuery({
    queryKey: ["samples", upsId, range],
    queryFn: () => api.get<Sample[]>(`/ups/${upsId}/samples?range=${range}`),
    refetchInterval: 60_000,
  });
  const points = data.map((s) => ({ t: new Date(s.ts).getTime(), battery: s.battery, load: s.load }));

  if (points.length < 2) {
    return (
      <div className="text-muted-foreground grid h-72 place-items-center text-sm">
        Not enough data yet
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={288}>
      <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
        <defs>
          <linearGradient id="batteryFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-2)" stopOpacity={0.35} />
            <stop offset="100%" stopColor="var(--chart-2)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis
          dataKey="t"
          type="number"
          scale="time"
          domain={["dataMin", "dataMax"]}
          tickFormatter={tickFormatter(range)}
          tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
          tickLine={false}
          axisLine={false}
          minTickGap={40}
        />
        <YAxis
          domain={[0, 100]}
          tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
          tickLine={false}
          axisLine={false}
          unit="%"
        />
        <Tooltip
          contentStyle={{
            background: "var(--popover)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            fontSize: 12,
          }}
          labelFormatter={(v) => formatDateTime(v as number)}
          formatter={(value, name) => [`${value}%`, name === "battery" ? "Battery" : "Load"]}
        />
        <Area type="monotone" dataKey="battery" stroke="var(--chart-2)" fill="url(#batteryFill)" strokeWidth={2} />
        <Area type="monotone" dataKey="load" stroke="var(--chart-1)" fill="none" strokeWidth={1.5} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
