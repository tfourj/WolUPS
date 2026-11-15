import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { CommandState } from "@/lib/types";

/** Live output of a NUT agent command, polled every second until it finishes. */
export function CommandLog({
  hostId,
  commandId,
  onFinished,
}: {
  hostId: string;
  commandId: string;
  onFinished: (state: CommandState) => void;
}) {
  const { data } = useQuery({
    queryKey: ["nut-command", hostId, commandId],
    queryFn: () => api.get<CommandState>(`/nut-hosts/${hostId}/commands/${commandId}`),
    refetchInterval: (query) => (query.state.data && query.state.data.status !== "running" ? false : 1_000),
  });
  const bottom = useRef<HTMLDivElement>(null);
  const reported = useRef(false);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [data?.lines.length]);

  useEffect(() => {
    if (data && data.status !== "running" && !reported.current) {
      reported.current = true;
      onFinished(data);
    }
  }, [data, onFinished]);

  return (
    <div className="bg-muted/50 max-h-64 overflow-auto rounded-md border p-3 font-mono text-xs">
      {data?.lines.length ? (
        data.lines.map((line, i) => (
          <div key={i} className="break-all whitespace-pre-wrap">
            {line}
          </div>
        ))
      ) : (
        <div className="text-muted-foreground">Waiting for output...</div>
      )}
      <div ref={bottom} />
    </div>
  );
}
