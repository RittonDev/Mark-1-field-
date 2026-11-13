"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { TicketEditor } from "@/components/ticket/editor/TicketEditor";
import { ErrorBox, LoadingBlock } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import type { TicketDetail } from "@/lib/types";

/** A OS no formato do "Editar atividade": abas e tudo editável pela central, aberta ou fechada. */
export default function TicketDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const query = useQuery({
    queryKey: ["ticket", id],
    queryFn: () => api.get<TicketDetail>(`/tickets/${id}`),
  });

  if (query.isLoading) return <LoadingBlock />;
  if (query.error || !query.data) {
    return (
      <div className="mx-auto max-w-3xl">
        <ErrorBox message={errorMessage(query.error)} />
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-6xl">
      <TicketEditor ticket={query.data} variant="page" />
    </div>
  );
}
