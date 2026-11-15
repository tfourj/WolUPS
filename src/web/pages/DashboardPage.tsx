import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { Activity, BatteryCharging, PlugZap, Server, Wifi, Zap } from "lucide-react";
import { BatteryChart } from "@/components/BatteryChart";
import { BatteryBar, EmptyState, StatCard, ToneBadge } from "@/components/common";
import { EventSummary } from "@/components/EventRow";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { formatRuntime, timeAgo, upsState } from "@/lib/format";
import type { Overview, Ups } from "@/lib/types";

function UpsCard({ ups }: { ups: Ups }) {
  const state = upsState(ups.status, ups.reachable);
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="truncate">{ups.name}</CardTitle>
        {ups.description && <CardDescription className="truncate">{ups.description}</CardDescription>}
        <CardAction>
          <ToneBadge tone={state.tone}>{state.label}</ToneBadge>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-end justify-between">
          <span className="text-4xl font-semibold tracking-tight">{ups.battery ?? "-"}%</span>
          <span className="text-muted-foreground text-sm">{formatRuntime(ups.runtime)} runtime</span>
        </div>
        <BatteryBar value={ups.battery} />
        <dl className="text-muted-foreground grid grid-cols-3 gap-2 text-xs">
          <div>
            <dt>Load</dt>
            <dd className="text-foreground text-sm font-medium">{ups.load ?? "-"}%</dd>
          </div>
          <div>
            <dt>Input</dt>
            <dd className="text-foreground text-sm font-medium">{ups.inputVoltage ?? "-"} V</dd>
          </div>
          <div>
            <dt>Polled</dt>
            <dd className="text-foreground text-sm font-medium">{timeAgo(ups.lastPolledAt)}</dd>
          </div>
        </dl>
        {ups.lastError && <p className="text-destructive text-xs">{ups.lastError}</p>}
      </CardContent>
    </Card>
  );
}

export function DashboardPage() {
  const { data, isPending } = useQuery({
    queryKey: ["overview"],
    queryFn: () => api.get<Overview>("/overview"),
    refetchInterval: 5_000,
  });
  const [chartUps, setChartUps] = useState<string>("");
  const [range, setRange] = useState("24h");

  useEffect(() => {
    if (!chartUps && data?.ups.length) setChartUps(data.ups[0].id);
  }, [data, chartUps]);

  if (isPending || !data) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
    );
  }

  const { counts } = data;

  if (counts.ups === 0) {
    return (
      <EmptyState icon={PlugZap} title="Add your first UPS to start monitoring">
        <Button asChild>
          <Link to="/ups">Add UPS</Link>
        </Button>
      </EmptyState>
    );
  }

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="UPS"
          value={counts.ups}
          hint={counts.upsOnBattery ? `${counts.upsOnBattery} on battery` : "All on line power"}
          icon={BatteryCharging}
          tone={counts.upsOnBattery ? "warning" : "success"}
        />
        <StatCard
          label="Devices online"
          value={`${counts.devicesOnline}/${counts.devices}`}
          icon={Server}
          tone={counts.devicesOnline === counts.devices ? "success" : "warning"}
        />
        <StatCard
          label="Agents connected"
          value={`${counts.agentsConnected}/${counts.agents}`}
          icon={Wifi}
          tone={counts.agentsConnected === counts.agents ? "success" : "warning"}
        />
        <StatCard
          label="Outages (30 days)"
          value={counts.outages30d}
          hint={data.lastOutage ? `Last ${timeAgo(data.lastOutage.startedAt)}` : "None recorded"}
          icon={Zap}
          tone={counts.activeOutages ? "error" : "info"}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data.ups.map((u) => (
          <UpsCard key={u.id} ups={u} />
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-5">
        <Card className="xl:col-span-3">
          <CardHeader>
            <CardTitle>Battery history</CardTitle>
            <CardAction className="flex flex-wrap items-center gap-2">
              {data.ups.length > 1 && (
                <Select value={chartUps} onValueChange={setChartUps}>
                  <SelectTrigger size="sm" className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {data.ups.map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Tabs value={range} onValueChange={setRange}>
                <TabsList>
                  {["6h", "24h", "7d", "30d"].map((r) => (
                    <TabsTrigger key={r} value={r}>
                      {r}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </CardAction>
          </CardHeader>
          <CardContent>{chartUps && <BatteryChart upsId={chartUps} range={range} />}</CardContent>
        </Card>

        {/* On wide screens the card is taken out of flow so the chart sets the row height. */}
        <div className="relative xl:col-span-2">
          <Card className="xl:absolute xl:inset-0">
            <CardHeader>
              <CardTitle>Recent events</CardTitle>
              <CardAction>
                <Button variant="ghost" size="sm" asChild>
                  <Link to="/events">View all</Link>
                </Button>
              </CardAction>
            </CardHeader>
            {data.recentEvents.length === 0 ? (
              <CardContent>
                <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
                  <Activity className="size-4" />
                  No events yet
                </div>
              </CardContent>
            ) : (
              <CardContent className="px-0 xl:min-h-0 xl:flex-1">
                <ScrollArea type="auto" className="xl:h-full">
                  <div className="divide-y px-6">
                    {data.recentEvents.map((e) => (
                      <EventSummary key={e.id} event={e} />
                    ))}
                  </div>
                </ScrollArea>
              </CardContent>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
