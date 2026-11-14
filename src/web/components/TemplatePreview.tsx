import type { EventType } from "@shared/events";
import { previewTemplate, type Template } from "@shared/templates";
import { notificationTimeOptions } from "@/lib/format";
import { cn } from "@/lib/utils";

/** A template rendered with an example event, as it would arrive in a notification. */
export function TemplatePreview({
  eventType,
  template,
  className,
}: {
  eventType: EventType;
  template: Template;
  className?: string;
}) {
  const { title, body } = previewTemplate(eventType, template, new Date(), notificationTimeOptions());
  return (
    <div className={cn("bg-muted/40 grid gap-1 rounded-md border px-3 py-2 text-sm", className)}>
      <p className={cn("font-medium break-words", !title && "text-muted-foreground italic")}>
        {title || "No title"}
      </p>
      <p className={cn("break-words whitespace-pre-wrap", !body && "text-muted-foreground italic")}>
        {body || "No body"}
      </p>
    </div>
  );
}
