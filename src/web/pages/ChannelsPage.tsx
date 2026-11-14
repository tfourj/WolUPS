import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bell, Pencil, Plus, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { CHANNEL_TYPES } from "@shared/channels";
import { EmptyState, PageHeader } from "@/components/common";
import { ConfirmAction } from "@/components/confirm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { useAction } from "@/lib/mutations";
import type { Channel } from "@/lib/types";
import { ChannelDialog } from "./ChannelDialog";

export function ChannelsPage() {
  const { data = [], isPending } = useQuery({ queryKey: ["channels"], queryFn: () => api.get<Channel[]>("/channels") });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Channel | undefined>();

  const toggle = useAction((c: Channel) => api.patch(`/channels/${c.id}`, { enabled: !c.enabled }), {
    invalidate: [["channels"]],
  });
  const remove = useAction((c: Channel) => api.delete(`/channels/${c.id}`), {
    invalidate: [["channels"]],
    success: "Channel deleted",
  });
  const test = useAction(
    (c: Channel) =>
      api.post<{ ok: boolean; error?: string }>("/channels/test", {
        id: c.id,
        type: c.type,
        name: c.name,
        config: c.config,
        titleTemplate: c.titleTemplate,
        bodyTemplate: c.bodyTemplate,
      }),
    { success: (r) => (r.ok ? "Test notification sent" : null) },
  );

  const openDialog = (c?: Channel) => {
    setEditing(c);
    setDialogOpen(true);
  };

  return (
    <>
      <PageHeader title="Channels">
        <Button onClick={() => openDialog()}>
          <Plus />
          Add channel
        </Button>
      </PageHeader>

      {!isPending && data.length === 0 ? (
        <EmptyState icon={Bell} title="No notification channels">
          <Button onClick={() => openDialog()}>Add channel</Button>
        </EmptyState>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.map((c) => (
            <Card key={c.id} className={c.enabled ? "" : "opacity-70"}>
              <CardHeader>
                <CardTitle className="truncate">{c.name}</CardTitle>
                <CardAction>
                  <Switch checked={c.enabled} onCheckedChange={() => toggle.mutate(c)} aria-label="Enabled" />
                </CardAction>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-1.5">
                <Badge variant="secondary">{CHANNEL_TYPES[c.type]?.label ?? c.type}</Badge>
                <Badge variant="outline">{c.events.length} events</Badge>
                {c.upsIds?.length ? <Badge variant="outline">{c.upsIds.length} UPS</Badge> : null}
                {c.deviceIds?.length ? <Badge variant="outline">{c.deviceIds.length} devices</Badge> : null}
              </CardContent>
              <CardFooter className="mt-auto gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    test.mutateAsync(c).then((r) => {
                      if (!r.ok) toast.error(r.error ?? "Test failed");
                    })
                  }
                >
                  <Send />
                  Test
                </Button>
                <Button variant="outline" size="sm" onClick={() => openDialog(c)}>
                  <Pencil />
                  Edit
                </Button>
                <ConfirmAction
                  title={`Delete ${c.name}?`}
                  description="Its delivery history is removed too."
                  confirmLabel="Delete"
                  destructive
                  onConfirm={() => remove.mutateAsync(c)}
                  trigger={
                    <Button variant="ghost" size="sm" className="text-destructive ml-auto">
                      <Trash2 />
                    </Button>
                  }
                />
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      <ChannelDialog open={dialogOpen} onOpenChange={setDialogOpen} channel={editing} />
    </>
  );
}
