import { EVENT_LABELS } from "@shared/events";
import { ToneBadge, severityTone } from "@/components/common";
import { timeAgo, formatDateTime } from "@/lib/format";
import type { EventItem } from "@/lib/types";

export function EventSummary({ event }: { event: EventItem }) {
  return (
    <div className="flex items-start gap-3 py-3">
      <ToneBadge tone={severityTone(event.severity)} className="mt-0.5 shrink-0">
        {EVENT_LABELS[event.type] ?? event.type}
      </ToneBadge>
      <div className="min-w-0 flex-1">
        <p className="text-sm">{event.message}</p>
      </div>
      <time className="text-muted-foreground shrink-0 text-xs" title={formatDateTime(event.createdAt)}>
        {timeAgo(event.createdAt)}
      </time>
    </div>
  );
}
