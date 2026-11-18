"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button, ErrorBox, SectionTitle, Skeleton } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { USER_CHANGE_LABEL } from "@/lib/constants";
import { formatShort } from "@/lib/format";
import type { UserChange, UserChangeField, UserChangeItem, UUID } from "@/lib/types";

/** Linhas na primeira vista e a cada "Ver mais". A API manda até 200, das mais recentes. */
const FIRST = 10;
const MORE = 20;
const FETCH = 50;
const FETCH_MAX = 200;

/** Valor vazio de cada campo ("Grupo: Campo → sem grupo"); os demais ficam "vazio". */
const EMPTY: Partial<Record<UserChangeField, string>> = {
  team: "sem grupo",
  services: "nenhum",
  work_schedule: "sem jornada",
};

interface ChangeLine {
  label: string;
  /** O de → para; sem ele, o rótulo já diz tudo ("Foto trocada"). */
  text?: string;
}

/**
 * Uma mudança como a central lê: "Cidade: Santos → Guarujá". Foto, senha e chave PIX têm frase própria; o
 * titular entra na chave cadastrada e sai junto com a chave removida.
 */
function lineOf(item: UserChangeItem, all: UserChangeItem[]): ChangeLine | null {
  const empty = EMPTY[item.field] ?? "vazio";
  switch (item.field) {
    case "avatar":
      return { label: item.to ? "Foto trocada" : "Foto removida" };
    case "password":
      return { label: item.to === "provisória" ? "Senha redefinida (provisória)" : item.to ? `Senha ${item.to}` : "Senha alterada" };
    case "pix": {
      if (!item.to) return { label: "Chave PIX removida" };
      if (!item.from) {
        const holder = all.find((c) => c.field === "pix_holder" && !c.from)?.to;
        return { label: "Chave PIX cadastrada", text: holder ? `${item.to} · titular ${holder}` : item.to };
      }
      break;
    }
    case "pix_holder":
      if (all.some((c) => c.field === "pix" && (!c.to || !c.from))) return null;
      break;
  }
  return { label: USER_CHANGE_LABEL[item.field] ?? item.field, text: `${item.from ?? empty} → ${item.to ?? empty}` };
}

function whoOf(row: UserChange): string {
  if (row.via === "app") return "pelo técnico, no app";
  return row.actor ? `por ${row.actor.name} na central` : "pela central";
}

/**
 * "Histórico do cadastro": o que mudou, quando, por quem e por onde (o técnico no app ou a central). A chave
 * PIX vem mascarada pela API; e-mail e celular, em claro (para desfazer uma troca indevida).
 */
export function ProfileHistory({ technicianId }: { technicianId: UUID }) {
  const [shown, setShown] = useState(FIRST);
  const limit = shown > FETCH ? FETCH_MAX : FETCH;
  const changes = useQuery({
    queryKey: ["technicians", "changes", technicianId, limit],
    queryFn: ({ signal }) => api.get<UserChange[]>(`/technicians/${technicianId}/changes`, { limit }, { signal }),
    placeholderData: keepPreviousData,
  });
  const rows = changes.data ?? [];
  // Buscando as próximas (de 50 para 200): o botão fica, girando, até chegarem.
  const more = changes.isPlaceholderData || rows.length > shown || (rows.length >= limit && limit < FETCH_MAX);

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-line p-3">
      <SectionTitle>Histórico do cadastro</SectionTitle>
      {changes.isLoading ? (
        <Skeleton className="h-10 w-full" />
      ) : changes.error && !rows.length ? (
        <ErrorBox message={errorMessage(changes.error)} onRetry={() => void changes.refetch()} />
      ) : !rows.length ? (
        <p className="text-xs text-ink-muted">Nenhuma alteração registrada.</p>
      ) : (
        <ol className="divide-y divide-line" aria-busy={changes.isPlaceholderData || undefined}>
          {rows.slice(0, shown).map((row) => {
            const lines = row.changes.map((item) => lineOf(item, row.changes)).filter((line): line is ChangeLine => !!line);
            return (
              <li key={row.id} className="py-2 first:pt-0 last:pb-0">
                <p className="text-xs text-ink-muted">
                  <time dateTime={row.created_at}>{formatShort(row.created_at)}</time> · {whoOf(row)}
                </p>
                <ul className="mt-0.5 flex flex-col gap-0.5 text-sm text-ink">
                  {lines.map((line, i) => (
                    <li key={i} className="break-words">
                      {line.text ? (
                        <>
                          <span className="font-medium">{line.label}:</span> {line.text}
                        </>
                      ) : (
                        <span className="font-medium">{line.label}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ol>
      )}
      {more ? (
        <Button size="sm" variant="ghost" className="self-start" loading={changes.isPlaceholderData} onClick={() => setShown((n) => n + MORE)}>
          Ver mais
        </Button>
      ) : null}
    </section>
  );
}
