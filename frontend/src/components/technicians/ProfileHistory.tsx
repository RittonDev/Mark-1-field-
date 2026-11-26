"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Button, ErrorBox, SectionTitle, Skeleton } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { APP_ACCESS, USER_CHANGE_LABEL } from "@/lib/constants";
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
  vehicle: "não informado",
  payout_preferred: "nenhuma",
};

/**
 * Listas em que a API grava o que entrou (`to`) e o que saiu (`from`), não o de → para: o perfil técnico (com as áreas
 * de atuação), os períodos de indisponibilidade e as formas de recebimento (itens separados por "; ").
 */
const DELTA_FIELDS: ReadonlySet<UserChangeField> = new Set<UserChangeField>([
  "tools",
  "availability",
  "skills",
  "education",
  "areas",
  "unavailability",
  "payout_methods",
]);

/**
 * A API manda a frase pronta em `to` (`from` null): documentos ("incluiu Certificação NR10 (vence 25/11/2027)"), anexos
 * internos, favoritos ("fixado em Cidade Exemplo-SP") e avaliações ("registrou OS-000123: 4 de 5").
 */
const PHRASE_FIELDS: ReadonlySet<UserChangeField> = new Set<UserChangeField>([
  "documents",
  "internal_attachments",
  "favorites",
  "ratings",
]);

/** A senha, pelo `to` da API: redefinida em Técnicos, definida em Usuários, trocada no app ou criada pelo link do e-mail. */
const PASSWORD_LINE: Record<string, string> = {
  "provisória": "Senha redefinida (provisória)",
  "definida pela central": "Senha definida pela central",
  "criada no app": "Senha criada no app",
  "trocada no app": "Senha trocada no app",
  "criada pelo link do e-mail": "Senha criada pelo link do e-mail",
  "redefinida pelo link do e-mail": "Senha redefinida pelo link do e-mail",
};

/**
 * O dado escondido de quem não pode ver: a API manda "***" no lugar da chave (ou da forma) de recebimento mascarada para
 * quem não tem Pagamentos (e não manda o titular; null continua null) e no lugar das frases dos anexos internos para
 * quem não tem Técnicos em Editar.
 */
const PAYOUT_HIDDEN = "***";

const payoutHidden = (item: UserChangeItem) => item.from === PAYOUT_HIDDEN || item.to === PAYOUT_HIDDEN;

/** Acesso ao app: as linhas antigas dizem "Bloqueado", que hoje é a situação na operação. */
const accessText = (value: string | null) => (value === "Bloqueado" ? APP_ACCESS.off : value);

interface ChangeLine {
  label: string;
  /** O de → para (ou "incluiu …" / "tirou …"); sem ele, o rótulo já diz tudo ("Foto trocada"). */
  text?: string;
}

/**
 * Uma mudança como a central lê: "Cidade: Santos → Guarujá". Foto, senha, link de senha, aprovação e chave PIX têm
 * frase própria; o titular entra na chave cadastrada e sai junto com a chave removida. Sem Pagamentos, o recebimento vem
 * sem valor ("Formas de recebimento alteradas") e sem titular; sem Técnicos em Editar, os anexos internos também
 * ("Anexos internos alterados", uma linha por registro). As listas dizem o que entrou e o que saiu, uma linha cada:
 * "Ferramental: incluiu Escada, Multímetro" e "Indisponibilidade: tirou 20/12/2026 a 05/01/2027". Documentos, anexos,
 * favoritos e avaliações vêm com a frase pronta: "Documentos: incluiu Certificação NR10 (vence 25/11/2027)".
 */
function linesOf(item: UserChangeItem, all: UserChangeItem[]): ChangeLine[] {
  // Campo que esta tela ainda não conhece (API mais nova): fica como "Cadastro".
  const label = USER_CHANGE_LABEL[item.field] ?? "Cadastro";
  if (item.field === "payout_methods" && payoutHidden(item)) return [{ label: "Formas de recebimento alteradas" }];
  if (item.field === "payout_preferred" && payoutHidden(item)) return [{ label: "Forma preferencial alterada" }];
  if (item.field === "internal_attachments" && payoutHidden(item)) {
    // Vários anexos escondidos no mesmo registro: uma linha só.
    const first = all.find((c) => c.field === "internal_attachments" && payoutHidden(c));
    return first === item ? [{ label: "Anexos internos alterados" }] : [];
  }
  if (PHRASE_FIELDS.has(item.field)) return [item.to ? { label, text: item.to } : { label }];
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
    case "password_link":
      // "enviado para alfa@exemplo.com".
      return [{ label, text: item.to ?? undefined }];
    case "application":
      // "Aprovado na homologação (HOM-…)".
      return [{ label: item.to ?? label }];
    case "is_active":
      return [{ label, text: `${accessText(item.from) ?? empty} → ${accessText(item.to) ?? empty}` }];
    case "email_verified":
      if (item.to === "validado") return [{ label: "E-mail validado" }];
      break;
    case "email_pending": {
      // Pedido no app: o e-mail novo espera o link. Saiu sem virar o login: a troca foi cancelada (pelo técnico, ou a
      // central trocou o e-mail). Virou o login: a linha do E-mail já conta.
      if (item.to && !item.from) return [{ label: "Troca de e-mail pedida", text: item.to }];
      if (item.from && !item.to) {
        if (all.some((c) => c.field === "email" && c.to === item.from)) return [];
        return [{ label: "Troca de e-mail cancelada", text: item.from }];
      }
      break;
    }
    case "pix": {
      if (!item.to) return [{ label: "Chave PIX removida" }];
      if (!item.from) {
        if (payoutHidden(item)) return [{ label: "Chave PIX cadastrada" }];
        const holder = all.find((c) => c.field === "pix_holder" && !c.from)?.to;
        return [{ label: "Chave PIX cadastrada", text: holder ? `${item.to} · titular ${holder}` : item.to }];
      }
      if (payoutHidden(item)) return [{ label: "Chave PIX alterada" }];
      break;
    }
    case "pix_holder":
      if (all.some((c) => c.field === "pix" && (!c.to || !c.from || payoutHidden(c)))) return [];
      // Sem Pagamentos, a troca só do titular (linha antiga) vem sem o nome.
      if (payoutHidden(item)) return [{ label: "Titular da conta alterado" }];
      break;
  }
  return [{ label, text: `${item.from ?? empty} → ${item.to ?? empty}` }];
}

/** Por onde a mudança veio: o técnico (no app ou pelo link do e-mail), a central ou a aprovação da ficha. */
function whoOf(row: UserChange): string {
  switch (row.via) {
    case "app":
      return "pelo técnico, no app";
    case "link":
      return "pelo técnico, pelo link do e-mail";
    case "ficha":
      return row.actor ? `por ${row.actor.name}, na aprovação da ficha` : "na aprovação da ficha";
    default:
      return row.actor ? `por ${row.actor.name} na central` : "pela central";
  }
}

/**
 * "Histórico do cadastro": o que mudou, quando, por quem e por onde (o técnico no app ou pelo link do e-mail, a
 * central ou a aprovação da ficha), com o motivo quando a mudança pede um (a situação na operação). O recebimento vem
 * mascarado pela API (sem Pagamentos, nem isso); e-mail e celular, em claro (para desfazer uma troca indevida). Vem da
 * API em páginas de PAGE pelo `before`, até a primeira linha: a troca antiga de PIX ou de e-mail continua ao alcance do
 * "Ver mais". A chave fica sob ["technicians"], que o tempo real e o salvar da ficha mandam buscar de novo (todas as
 * páginas já abertas). `bare`: sem a borda e o título (a seção Histórico da ficha já tem os dela).
 */
export function ProfileHistory({ technicianId, bare = false }: { technicianId: UUID; bare?: boolean }) {
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

  const body = (
    <>
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
                {row.note ? (
                  <p className="mt-0.5 text-xs break-words text-ink-muted">
                    {/* Nos favoritos, a nota do pedido (fixar, tirar); nos outros, o motivo (a situação na operação). */}
                    {row.changes.some((c) => c.field === "favorites") ? "Nota" : "Motivo"}: {row.note}
                  </p>
                ) : null}
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
    </>
  );

  if (bare) return <div className="flex flex-col gap-2">{body}</div>;
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-line p-3">
      <SectionTitle>Histórico do cadastro</SectionTitle>
      {body}
    </section>
  );
}
