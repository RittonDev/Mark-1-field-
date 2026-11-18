"use client";

import { useQuery } from "@tanstack/react-query";
import { FileSearch } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { NoAccess } from "@/components/NoAccess";
import { TicketEditor } from "@/components/ticket/editor/TicketEditor";
import { buttonClassName, EmptyState, ErrorBox, LoadingBlock } from "@/components/ui";
import { api, ApiError, errorMessage } from "@/lib/api";
import { forbiddenCode, forbiddenItem } from "@/lib/permissions";
import type { TicketDetail, UUID } from "@/lib/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** O nº como a central fala e digita: "15829", "015829", "OS-015829", "os15829". */
const NUMBER_RE = /^(?:os)?[\s#-]*0*(\d{1,9})$/i;

/** O trecho da URL como foi digitado ("OS%20123" vira "OS 123"); malformado, fica como veio. */
function decoded(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function NotFound({ what }: { what: string }) {
  return (
    <div className="mx-auto max-w-3xl">
      <EmptyState
        icon={<FileSearch />}
        title={`${what} não encontrada`}
        description="Confira o número ou procure na lista de chamados."
        action={
          <Link href="/chamados" className={buttonClassName("primary")}>
            Voltar para Chamados
          </Link>
        }
      />
    </div>
  );
}

/** A OS no formato do "Editar atividade": abas e tudo editável pela central, aberta ou fechada. */
export default function TicketDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = decoded(params.id).trim();
  const isId = UUID_RE.test(id);
  // /chamados/15829: a central conhece a OS pelo número; acha o id e troca a URL.
  const match = isId ? null : (NUMBER_RE.exec(id)?.[1] ?? null);
  // "0" não é número de OS: cai no "não encontrada" sem perguntar à API.
  const number = match !== null && Number(match) > 0 ? Number(match) : null;
  const query = useQuery({
    queryKey: ["ticket", id],
    queryFn: () => api.get<TicketDetail>(`/tickets/${id}`),
    enabled: isId,
  });
  const lookup = useQuery({
    queryKey: ["ticket-number", number],
    queryFn: async () => {
      // O nº exato; a API diz também quando a OS existe mas é de outra fila (403), sem mostrar nada dela.
      try {
        return (await api.get<{ id: UUID; code: string }>("/tickets/lookup", { number: number ?? undefined })).id;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: number !== null,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (lookup.data) router.replace(`/chamados/${lookup.data}`);
  }, [lookup.data, router]);

  if (number !== null) {
    if (forbiddenCode(lookup.error) === "QUEUE_FORBIDDEN") return <NoAccess kind="queue" />;
    if (lookup.error) {
      return (
        <div className="mx-auto max-w-3xl">
          <ErrorBox message={errorMessage(lookup.error)} onRetry={() => void lookup.refetch()} />
        </div>
      );
    }
    if (lookup.data === null) return <NotFound what={`OS nº ${number}`} />;
    return <LoadingBlock label="Abrindo a OS..." />;
  }
  if (!isId || (query.error instanceof ApiError && query.error.status === 404)) return <NotFound what="OS" />;
  // OS de outra fila (link direto, recente, aviso antigo): a tela amigável no lugar do erro.
  const denied = forbiddenCode(query.error);
  if (denied === "QUEUE_FORBIDDEN") return <NoAccess kind="queue" />;
  if (denied === "MODULE_FORBIDDEN") return <NoAccess kind="module" item={forbiddenItem(query.error)} />;
  if (query.isLoading) return <LoadingBlock label="Abrindo a OS..." />;
  if (query.error || !query.data) {
    return (
      <div className="mx-auto max-w-3xl">
        <ErrorBox message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-6xl">
      {/* A OS guardada (aberta antes) pode ser antiga até a releitura chegar. */}
      <TicketEditor ticket={query.data} variant="page" synced={query.isFetchedAfterMount || !query.isStale} />
    </div>
  );
}
