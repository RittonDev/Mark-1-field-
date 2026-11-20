"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Button, ErrorBox, SectionTitle, Skeleton } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { USER_CHANGE_LABEL } from "@/lib/constants";
import { formatShort } from "@/lib/format";
import type { UserChange, UserChangeField, UserChangeItem, UUID } from "@/lib/types";

/** Linhas na primeira vista e a cada "Ver mais". */
const FIRST = 10;
const MORE = 20;
/** Linhas por página da API, das mais recentes para as mais antigas. */
const PAGE = 50;

/** As páginas numa lista só, sem repetir linha (a API que ainda ignora o `before` manda a primeira página de novo). */
function joinPages(pages: UserChange[][]): UserChange[] {
  const seen = new Set<UUID>();
  const rows: UserChange[] = [];
  for (const page of pages) {
    for (const row of page) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
  }
  return rows;
}

/**
 * O `before` da página seguinte: a hora e o id da última linha recebida ("<created_at>|<id>"). Sem página seguinte
 * quando a última veio incompleta (o histórico acabou) ou sem nenhuma linha nova (a API que ainda ignora o `before`
 * devolve a primeira página de novo).
 */
function nextBefore(last: UserChange[], pages: UserChange[][]): string | undefined {
  if (last.length < PAGE) return undefined;
  const earlier = new Set(pages.slice(0, -1).flatMap((page) => page.map((row) => row.id)));
  if (last.every((row) => earlier.has(row.id))) return undefined;
  const tail = last[last.length - 1];
  return `${tail.created_at}|${tail.id}`;
}

/** Valor vazio de cada campo ("Grupo: Campo → sem grupo"); os demais ficam "vazio". */
const EMPTY: Partial<Record<UserChangeField, string>> = {
  team: "sem grupo",
  services: "nenhum",
  work_schedule: "sem jornada",
  transport: "não informado",
};

/** Partes do perfil técnico em que a API grava o que entrou (`to`) e o que saiu (`from`), não o de → para. */
const DELTA_FIELDS: ReadonlySet<UserChangeField> = new Set<UserChangeField>(["tools", "availability", "skills", "education"]);

/** A senha, pelo `to` da API: redefinida em Técnicos, definida em Usuários ou trocada pelo técnico no app. */
const PASSWORD_LINE: Record<string, string> = {
  "provisória": "Senha redefinida (provisória)",
  "definida pela central": "Senha definida pela central",
  "criada no app": "Senha criada no app",
  "trocada no app": "Senha trocada no app",
};

/** A chave PIX para quem não tem Pagamentos: a API manda "***" no lugar da chave mascarada e não manda o titular. */
const PIX_HIDDEN = "***";

const pixHidden = (item: UserChangeItem) => item.from === PIX_HIDDEN || item.to === PIX_HIDDEN;

interface ChangeLine {
  label: string;
  /** O de → para (ou "incluiu …" / "tirou …"); sem ele, o rótulo já diz tudo ("Foto trocada"). */
  text?: string;
}

/**
 * Uma mudança como a central lê: "Cidade: Santos → Guarujá". Foto, senha e chave PIX têm frase própria; o
 * titular entra na chave cadastrada e sai junto com a chave removida. Sem Pagamentos, a chave vem sem valor
 * ("Chave PIX alterada") e sem titular. Ferramental, disponibilidade, aptidões e formação dizem o que entrou e o
 * que saiu, uma linha cada: "Ferramental: incluiu Escada, Multímetro" e "Ferramental: tirou Furadeira".
 */
function linesOf(item: UserChangeItem, all: UserChangeItem[]): ChangeLine[] {
  const label = USER_CHANGE_LABEL[item.field] ?? item.field;
  if (DELTA_FIELDS.has(item.field)) {
    const lines: ChangeLine[] = [];
    if (item.to) lines.push({ label, text: `incluiu ${item.to}` });
    if (item.from) lines.push({ label, text: `tirou ${item.from}` });
    return lines;
  }
  const empty = EMPTY[item.field] ?? "vazio";
  switch (item.field) {
    case "avatar":
      return [{ label: item.to ? "Foto trocada" : "Foto removida" }];
    case "password":
      return [{ label: (item.to && PASSWORD_LINE[item.to]) || (item.to ? `Senha ${item.to}` : "Senha alterada") }];
    case "pix": {
      if (!item.to) return [{ label: "Chave PIX removida" }];
      if (!item.from) {
        if (pixHidden(item)) return [{ label: "Chave PIX cadastrada" }];
        const holder = all.find((c) => c.field === "pix_holder" && !c.from)?.to;
        return [{ label: "Chave PIX cadastrada", text: holder ? `${item.to} · titular ${holder}` : item.to }];
      }
      if (pixHidden(item)) return [{ label: "Chave PIX alterada" }];
      break;
    }
    case "pix_holder":
      if (all.some((c) => c.field === "pix" && (!c.to || !c.from || pixHidden(c)))) return [];
      break;
  }
  return [{ label, text: `${item.from ?? empty} → ${item.to ?? empty}` }];
}

function whoOf(row: UserChange): string {
  if (row.via === "app") return "pelo técnico, no app";
  return row.actor ? `por ${row.actor.name} na central` : "pela central";
}

/**
 * "Histórico do cadastro": o que mudou, quando, por quem e por onde (o técnico no app ou a central). A chave
 * PIX vem mascarada pela API (sem Pagamentos, nem isso); e-mail e celular, em claro (para desfazer uma troca
 * indevida). Vem da API em páginas de PAGE pelo `before`, até a primeira linha: a troca antiga de PIX ou de e-mail
 * continua ao alcance do "Ver mais". A chave fica sob ["technicians"], que o tempo real e o salvar da ficha mandam
 * buscar de novo (todas as páginas já abertas).
 */
export function ProfileHistory({ technicianId }: { technicianId: UUID }) {
  const [shown, setShown] = useState(FIRST);
  const changes = useInfiniteQuery({
    queryKey: ["technicians", "changes", technicianId],
    queryFn: ({ pageParam, signal }) =>
      api.get<UserChange[]>(`/technicians/${technicianId}/changes`, { limit: PAGE, before: pageParam || undefined }, { signal }),
    initialPageParam: "",
    getNextPageParam: (last, pages) => nextBefore(last, pages),
  });
  const rows = useMemo(() => joinPages(changes.data?.pages ?? []), [changes.data]);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = changes;
  // A página seguinte falhou: o aviso, com "Tentar de novo", fica no lugar do "Ver mais".
  const moreFailed = changes.isFetchNextPageError && !isFetchingNextPage;
  const more = rows.length > shown || hasNextPage;
  const showMore = () => {
    const next = shown + MORE;
    setShown(next);
    // As linhas já carregadas não enchem a vista: busca a página seguinte (o botão gira até ela chegar).
    if (next > rows.length && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  };

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-line p-3">
      <SectionTitle>Histórico do cadastro</SectionTitle>
      {changes.isLoading ? (
        <Skeleton className="h-10 w-full" />
      ) : changes.isError && !rows.length ? (
        <ErrorBox message={errorMessage(changes.error)} onRetry={() => void changes.refetch()} />
      ) : !rows.length ? (
        <p className="text-xs text-ink-muted">Nenhuma alteração registrada.</p>
      ) : (
        <ol className="divide-y divide-line" aria-busy={isFetchingNextPage || undefined}>
          {rows.slice(0, shown).map((row) => {
            const lines = row.changes.flatMap((item) => linesOf(item, row.changes));
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
      {moreFailed ? (
        <ErrorBox message={errorMessage(changes.error)} onRetry={() => void fetchNextPage()} />
      ) : more ? (
        <Button size="sm" variant="ghost" className="self-start" loading={isFetchingNextPage} onClick={showMore}>
          Ver mais
        </Button>
      ) : null}
    </section>
  );
}
