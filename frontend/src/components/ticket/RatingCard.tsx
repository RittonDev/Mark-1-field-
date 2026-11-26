"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Trash2 } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useConfirm } from "@/components/Confirm";
import { RatingInput, RatingStars } from "@/components/technicians/RatingStars";
import { TechnicianLink } from "@/components/technicians/TechnicianLink";
import { useToast } from "@/components/Toaster";
import { Button, Card, CardHeader, Dialog, ErrorBox, Field, Input, Skeleton, Textarea } from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets, RATING_LIMITS } from "@/lib/constants";
import { formatDate } from "@/lib/format";
import { useCan } from "@/lib/permissions";
import {
  isLowScore,
  type RatingField,
  type RatingForm,
  ratingBody,
  ratingFormOf,
  ratingProblem,
  ratingTrail,
  raterText,
  sameRating,
  scoreText,
} from "@/lib/ratings";
import type { TechnicianRating, TechnicianRatingIn, TicketDetail, TicketRatings, TicketStatus, UserRef, UUID } from "@/lib/types";

/** Só a OS concluída recebe avaliação (a reaberta mantém as que tinha, só para consulta). */
const CONCLUDED: TicketStatus[] = ["resolved", "closed"];

type Row = TicketRatings["technicians"][number];

const ROLE_LABEL: Record<Row["role"], string> = { assignee: "Responsável", helper: "Auxiliar", former: "Saiu da OS" };
const ROLE_ORDER: Row["role"][] = ["assignee", "helper", "former"];

const NAME_LINK =
  "rounded underline-offset-2 hover:text-brand hover:underline focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none";

/** A nota baixa é problema: em vermelho, como na área Avaliações da ficha. */
const LOW = "text-red-700 dark:text-red-400";

const ratingsKey = (ticketId: UUID) => ["ticket", ticketId, "ratings"] as const;

/** A API de antes da Entrega 2 (404) ou a OS fora da fila de quem vê (403): o cartão some, sem erro. */
function unavailable(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 403);
}

/**
 * O nome vira o link da ficha só para técnico: quem está na OS tem o papel nela (a equipe interna fica em texto); quem
 * saiu só aparece com avaliação, que é de técnico.
 */
function isTechnician(row: Row, ticket: TicketDetail): boolean {
  if (row.role === "former") return true;
  const people: UserRef[] = [...(ticket.assignee ? [ticket.assignee] : []), ...(ticket.helpers ?? [])];
  const person = people.find((p) => p.id === row.technician.id);
  return person ? person.role === "technician" : true;
}

/**
 * Avaliação do cliente na aba Geral (só a gestão; o técnico nunca vê): uma linha por técnico da OS (responsável,
 * auxiliares e quem saiu com avaliação), com a nota, o comentário, quem avaliou e quem registrou. Aparece com a OS
 * concluída ou quando já há avaliação (a OS reaberta mantém). Com a OS editável e concluída, "Registrar" / "Editar"
 * abrem o diálogo do técnico. A API de antes (sem a rota) e a OS de outra fila: o cartão some.
 */
export function RatingCard({ ticket, className }: { ticket: TicketDetail; className?: string }) {
  const { user } = useAuth();
  const canTechnicians = useCan("base.technicians");
  // A rota é da gestão das OS (o portal e o técnico não chegam aqui).
  const manager = canManageTickets(user?.role);
  // O técnico do diálogo como estava ao abrir: o diálogo fica aberto mesmo se a lista mudar por fora (o Salvar explica).
  const [editing, setEditing] = useState<Row | null>(null);
  const ratings = useQuery({
    queryKey: ratingsKey(ticket.id),
    queryFn: ({ signal }) => api.get<TicketRatings>(`/tickets/${ticket.id}/ratings`, undefined, { signal }),
    enabled: manager,
  });

  if (!manager) return null;
  const dialog = editing ? (
    <RatingDialog key={editing.technician.id} ticketId={ticket.id} row={editing} onClose={() => setEditing(null)} />
  ) : null;
  const concluded = CONCLUDED.includes(ticket.status);
  const rows = [...(ratings.data?.technicians ?? [])].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
  // Fora da conclusão, o cartão só aparece com avaliação (nem carregando nem com erro).
  if (unavailable(ratings.error) || (!concluded && !rows.some((row) => row.rating))) return dialog;
  const canEdit = ticket.can_edit && concluded;

  return (
    <>
      <Card className={className}>
        <CardHeader title="Avaliação do cliente" />
        <div className="px-5 py-2">
          {ratings.isPending ? (
            <div role="status" className="flex flex-col gap-2 py-3">
              <span className="sr-only">Carregando a avaliação...</span>
              <Skeleton className="h-3.5 w-1/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ) : ratings.error && !ratings.data ? (
            <div className="py-3">
              <ErrorBox message={errorMessage(ratings.error)} onRetry={() => void ratings.refetch()} />
            </div>
          ) : rows.length === 0 ? (
            <p className="py-3 text-sm text-ink-muted">Nenhum técnico nesta OS.</p>
          ) : (
            <ul className="divide-y divide-line">
              {rows.map((row) => {
                const { technician, rating } = row;
                // Quem saiu da OS só tem a avaliação corrigida ou excluída (não recebe outra).
                const action = canEdit && (rating || row.role !== "former") ? (rating ? "Editar" : "Registrar") : null;
                return (
                  <li key={technician.id} className="flex flex-wrap items-start gap-x-3 gap-y-1.5 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-ink">
                        {canTechnicians && isTechnician(row, ticket) ? (
                          // A ficha do técnico (Ctrl/⌘+clique e o botão do meio abrem outra aba).
                          <TechnicianLink id={technician.id} className={NAME_LINK}>
                            {technician.name}
                          </TechnicianLink>
                        ) : (
                          technician.name
                        )}
                      </p>
                      <p className="text-xs text-ink-muted">{ROLE_LABEL[row.role] ?? row.role}</p>
                      {rating ? <RatingSummary rating={rating} /> : <p className="mt-1 text-sm text-ink-muted">Sem avaliação.</p>}
                    </div>
                    {action ? (
                      <Button size="sm" onClick={() => setEditing(row)} aria-label={`${action} a avaliação de ${technician.name}`}>
                        {action}
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Card>
      {dialog}
    </>
  );
}

/** A avaliação gravada: estrelas e "{n} de 5", o comentário, quem avaliou no cliente e quem registrou na central. */
function RatingSummary({ rating }: { rating: TechnicianRating }) {
  const rater = raterText(rating.rater_name);
  return (
    <div className="mt-1.5 flex flex-col gap-1">
      <p className="flex items-center gap-1.5 text-sm">
        <RatingStars value={rating.score} size="sm" />
        <span className={clsx("font-medium", isLowScore(rating.score) ? LOW : "text-ink")}>{scoreText(rating.score)}</span>
      </p>
      {rating.comment ? <p className="text-sm break-words whitespace-pre-wrap text-ink">“{rating.comment}”</p> : null}
      {rater ? <p className="text-xs text-ink-muted">{rater}</p> : null}
      <p className="text-xs text-ink-muted">{ratingTrail(rating, formatDate)}</p>
    </div>
  );
}

/** Caracteres como o servidor conta (um emoji é um só), sem os espaços das pontas. */
const chars = (text: string) => Array.from(text.trim()).length;

/**
 * "Avaliação de {nome}": a nota (obrigatória), o comentário e quem avaliou no cliente. Salvar fica travado sem mudança;
 * com avaliação gravada, "Excluir" (confirma). Os erros da tela aparecem a partir do primeiro Salvar; o do servidor (OS
 * reaberta, técnico fora da OS, avaliação já excluída) fica no fim, e a OS é relida.
 */
function RatingDialog({ ticketId, row, onClose }: { ticketId: UUID; row: Row; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const ids = useId();
  const formId = `${ids}-form`;
  const scoreId = `${ids}-nota`;
  const scoreLabelId = `${ids}-nota-rotulo`;
  const scoreErrorId = `${ids}-nota-erro`;
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const raterRef = useRef<HTMLInputElement>(null);
  const { technician, rating: saved } = row;
  const name = technician.name;
  const [initial] = useState<RatingForm>(() => ratingFormOf(saved));
  const [form, setForm] = useState<RatingForm>(initial);
  const [tried, setTried] = useState(false);
  const errors = ratingProblem(form);
  const shown = (field: RatingField) => (tried ? (errors[field] ?? null) : null);
  const touched = form.score !== initial.score || form.comment !== initial.comment || form.rater_name !== initial.rater_name;
  // Com avaliação gravada, mudar é o que o servidor gravaria de diferente (espaços nas pontas não contam).
  const changed = saved ? !sameRating(form, saved) : touched;

  /** A OS (com o histórico e as avaliações) e as telas do técnico (a lista, a ficha e a média). */
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["ticket", ticketId] });
    void queryClient.invalidateQueries({ queryKey: ["technicians"] });
  };
  /** A linha do técnico com a avaliação nova (ou sem ela) já na tela, antes de a lista chegar de novo. */
  const patchRow = (rating: TechnicianRating | null) =>
    queryClient.setQueryData<TicketRatings>(ratingsKey(ticketId), (old) =>
      old
        ? {
            ...old,
            technicians: old.technicians
              .map((t) => (t.technician.id === technician.id ? { ...t, rating } : t))
              // Quem saiu da OS só fica na lista com avaliação.
              .filter((t) => t.role !== "former" || t.rating),
          }
        : old,
    );

  const save = useMutation({
    mutationFn: (body: TechnicianRatingIn) => api.put<TechnicianRating>(`/tickets/${ticketId}/ratings/${technician.id}`, body),
    onSuccess: (rating) => {
      patchRow(rating);
      toast({ title: "Avaliação salva", tone: "success" });
      onClose();
    },
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/tickets/${ticketId}/ratings/${technician.id}`),
    onSuccess: () => {
      patchRow(null);
      toast({ title: "Avaliação excluída", tone: "success" });
      onClose();
    },
    onSettled: refresh,
  });
  const busy = save.isPending || remove.isPending;
  const failure = save.error ?? remove.error;

  const set = <K extends keyof RatingForm>(key: K, value: RatingForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  /** Leva ao primeiro campo com problema (a nota: a estrela que recebe o Tab). */
  const focusProblem = () => {
    if (errors.score) document.getElementById(scoreId)?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]')?.focus();
    else if (errors.comment) commentRef.current?.focus();
    else if (errors.rater_name) raterRef.current?.focus();
  };

  const submit = () => {
    if (busy || !changed) return;
    setTried(true);
    if (form.score === null || errors.score || errors.comment || errors.rater_name) {
      focusProblem();
      return;
    }
    remove.reset();
    save.mutate(ratingBody({ ...form, score: form.score }));
  };

  const askRemove = async () => {
    const ok = await confirm({ tone: "danger", title: "Excluir a avaliação?", description: `Sai da ficha de ${name}.`, confirmLabel: "Excluir" });
    if (!ok) return;
    save.reset();
    remove.mutate();
  };

  const commentLength = chars(form.comment);
  return (
    <Dialog
      open
      onClose={onClose}
      dirty={touched && !busy}
      busy={busy}
      title={`Avaliação de ${name}`}
      footer={
        <>
          {saved ? (
            <Button variant="ghost" className="mr-auto" onClick={() => void askRemove()} loading={remove.isPending} disabled={busy}>
              {remove.isPending ? null : <Trash2 aria-hidden className="size-4" />}
              Excluir
            </Button>
          ) : null}
          <Button onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={save.isPending} disabled={!changed || busy}>
            Salvar
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {/* Fora de um Field (que é um <label>: o clique no rótulo marcaria a primeira estrela). */}
        <div className="flex flex-col gap-1.5">
          <span id={scoreLabelId} className="text-xs font-semibold text-ink/80">
            Nota<span className="text-red-600 dark:text-red-400"> *</span>
          </span>
          <RatingInput
            id={scoreId}
            value={form.score}
            onChange={(score) => set("score", score)}
            disabled={busy}
            labelledBy={scoreLabelId}
            describedBy={shown("score") ? scoreErrorId : undefined}
            invalid={Boolean(shown("score"))}
          />
          {shown("score") ? (
            <span id={scoreErrorId} role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">
              {shown("score")}
            </span>
          ) : null}
        </div>
        <div className="flex flex-col gap-1">
          <Field label="Comentário" error={shown("comment")}>
            <Textarea
              ref={commentRef}
              rows={4}
              value={form.comment}
              onChange={(e) => set("comment", e.target.value)}
              // Com folga acima do limite: o contador fica vermelho e o Salvar explica, em vez de cortar o texto colado.
              maxLength={RATING_LIMITS.comment * 2}
              disabled={busy}
              aria-invalid={shown("comment") ? true : undefined}
            />
          </Field>
          <span
            className={clsx(
              "self-end text-[11px] tabular-nums",
              commentLength > RATING_LIMITS.comment ? "font-medium text-red-600 dark:text-red-400" : "text-ink-subtle",
            )}
          >
            {commentLength.toLocaleString("pt-BR")} / {RATING_LIMITS.comment.toLocaleString("pt-BR")}
          </span>
        </div>
        <Field label="Quem avaliou" error={shown("rater_name")}>
          <Input
            ref={raterRef}
            value={form.rater_name}
            onChange={(e) => set("rater_name", e.target.value)}
            maxLength={RATING_LIMITS.rater * 2}
            autoComplete="off"
            disabled={busy}
            aria-invalid={shown("rater_name") ? true : undefined}
          />
        </Field>
        {failure ? <ErrorBox message={errorMessage(failure)} /> : null}
      </form>
    </Dialog>
  );
}
