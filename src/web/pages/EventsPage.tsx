import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Activity, ChevronLeft, ChevronRight, RotateCw } from "lucide-react";
import { EVENT_LABELS, EVENT_TYPES } from "@shared/events";
import { EmptyState, ToneBadge, severityTone, type Tone } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { formatDateTime, timeAgo } from "@/lib/format";
import { useAction } from "@/lib/mutations";
import type { Delivery, EventItem } from "@/lib/types";

const ALL = "all";
const PAGE_SIZE = 25;

const deliveryTone: Record<Delivery["status"], Tone> = { success: "success", pending: "warning", failed: "error" };

function DeliveryBadge({ delivery }: { delivery: Delivery }) {
  const retry = useAction(() => api.post(`/events/deliveries/${delivery.id}/retry`), {
    invalidate: [["events"]],
    success: "Retry queued",
  });
  const detail =
    delivery.status === "success"
      ? `Delivered ${formatDateTime(delivery.deliveredAt)}`
      : `${delivery.attempts} attempt(s)${delivery.lastError ? `: ${delivery.lastError}` : ""}`;
  return (
    <span className="inline-flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <ToneBadge tone={deliveryTone[delivery.status]}>{delivery.channelName}</ToneBadge>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{detail}</TooltipContent>
      </Tooltip>
      {delivery.status === "failed" && (
        <Button size="icon" variant="ghost" className="size-6" onClick={() => retry.mutate(undefined)} aria-label="Retry">
          <RotateCw className="size-3" />
        </Button>
      )}
    </span>
  );
}

export function EventsPage() {
  const [page, setPage] = useState(1);
  const [type, setType] = useState(ALL);
  const [severity, setSeverity] = useState(ALL);
  const [q, setQ] = useState("");

  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (type !== ALL) params.set("type", type);
  if (severity !== ALL) params.set("severity", severity);
  if (q.trim()) params.set("q", q.trim());

  const { data, isPending } = useQuery({
    queryKey: ["events", params.toString()],
    queryFn: () => api.get<{ total: number; items: EventItem[] }>(`/events?${params}`),
    placeholderData: keepPreviousData,
    refetchInterval: 10_000,
  });
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));
  const reset = <T,>(fn: (v: T) => void) => (v: T) => {
    fn(v);
    setPage(1);
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={q}
          onChange={(e) => reset(setQ)(e.target.value)}
          placeholder="Search events"
          className="w-full sm:w-64"
        />
        <Select value={type} onValueChange={reset(setType)}>
          <SelectTrigger className="w-full sm:w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All event types</SelectItem>
            {EVENT_TYPES.filter((t) => t !== "test").map((t) => (
              <SelectItem key={t} value={t}>
                {EVENT_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={severity} onValueChange={reset(setSeverity)}>
          <SelectTrigger className="w-full sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All severities</SelectItem>
            <SelectItem value="error">Error</SelectItem>
            <SelectItem value="warning">Warning</SelectItem>
            <SelectItem value="success">Success</SelectItem>
            <SelectItem value="info">Info</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-muted-foreground ml-auto text-sm">{data?.total ?? 0} events</span>
      </div>

      {!isPending && data?.items.length === 0 ? (
        <EmptyState icon={Activity} title="No events match" />
      ) : (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Time</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Details</TableHead>
                <TableHead className="hidden lg:table-cell">Notifications</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.items.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="text-muted-foreground pl-4 align-top text-xs whitespace-nowrap">
                    <span title={formatDateTime(e.createdAt)}>{timeAgo(e.createdAt)}</span>
                  </TableCell>
                  <TableCell className="align-top">
                    <ToneBadge tone={severityTone(e.severity)}>{EVENT_LABELS[e.type] ?? e.type}</ToneBadge>
                  </TableCell>
                  <TableCell className="align-top whitespace-normal">
                    <p className="text-sm">{e.message}</p>
                    {(e.upsName || e.deviceName) && (
                      <p className="text-muted-foreground mt-0.5 text-xs">
                        {[e.upsName, e.deviceName].filter(Boolean).join(" · ")}
                      </p>
                    )}
                  </TableCell>
                  <TableCell className="hidden align-top lg:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {e.deliveries?.length ? (
                        e.deliveries.map((d) => <DeliveryBadge key={d.id} delivery={d} />)
                      ) : (
                        <span className="text-muted-foreground text-xs">-</span>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-end gap-2">
          <span className="text-muted-foreground text-sm">
            Page {page} of {pages}
          </span>
          <Button variant="outline" size="icon" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous">
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            size="icon"
            disabled={page >= pages}
            onClick={() => setPage(page + 1)}
            aria-label="Next"
          >
            <ChevronRight />
          </Button>
        </div>
      )}
    </>
  );
}
