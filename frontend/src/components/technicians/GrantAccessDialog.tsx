"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Check, Copy, KeyRound, MessageCircle } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useToast } from "@/components/Toaster";
import { Button, buttonClassName, Dialog, ErrorBox, Skeleton } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { isSendableEmail, OPERATIONAL_STATUS, PASSWORD_RESET_HOURS } from "@/lib/constants";
import { useMailEnabled } from "@/lib/queries";
import type { EmailQueued, Technician, TemporaryPassword, UUID } from "@/lib/types";
import { whatsappUrl } from "@/lib/whatsapp";
import { refreshTechnicianViews } from "./refresh";
import { useCopy } from "./useCopy";

/** Senha provisória: aparece uma vez, com atalhos para enviar ao técnico. */
export function TempPasswordPanel({ result }: { result: TemporaryPassword }) {
  const copy = useCopy();
  const codeRef = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  const { technician: t, temporary_password: pw } = result;
  const message = `Olá, ${t.name.trim().split(/\s+/)[0]}! Seu acesso ao app Maxx Field: e-mail ${t.email} e senha provisória ${pw}. No primeiro acesso, o app pede para você criar uma senha nova.`;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink">
        Senha provisória de <strong>{t.name}</strong>. No primeiro acesso ao app, ele cria uma senha nova.
      </p>
      <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 p-2">
        <code ref={codeRef} className="flex-1 text-center font-mono text-lg tracking-wider text-ink">
          {pw}
        </code>
        <Button
          onClick={async () => {
            if (await copy(pw, { select: codeRef.current, title: "Senha copiada" })) setCopied(true);
          }}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copied ? "Copiada" : "Copiar"}
        </Button>
      </div>
      <a href={whatsappUrl(t.phone, message)} target="_blank" rel="noreferrer" className={buttonClassName("secondary", "md", "self-start")}>
        <MessageCircle className="size-4" />
        {t.phone ? "Enviar no WhatsApp dele" : "Enviar por WhatsApp"}
      </a>
      <p className="text-xs text-ink-muted">Por segurança, esta senha não aparece de novo. Se perder, gere outra.</p>
    </div>
  );
}

// --------------------------------------------------------------------------- escolha da senha

/** Manter a senha que ele já usa (só ao liberar), mandar o link de nova senha por e-mail ou gerar a provisória. */
export type PasswordChoiceKey = "keep" | "link" | "temp";

type ChoiceTech = Pick<Technician, "email" | "is_active" | "last_login_at" | "must_change_password" | "email_verified_at">;

/** Por que o link por e-mail não dá; null quando dá. `needsAccess`: o link pede o acesso liberado (Redefinir senha). */
function linkLock(tech: ChoiceTech, mailEnabled: boolean | undefined, needsAccess: boolean): string | null {
  if (!isSendableEmail(tech.email)) return "Sem e-mail válido.";
  if (mailEnabled === false) return "Envio de e-mail desligado.";
  if (needsAccess && !tech.is_active) return "Sem acesso ao app.";
  return null;
}

/** Ao liberar, "Manter a senha dele" só para quem já entrou com uma senha própria (não a provisória). */
const canKeep = (tech: ChoiceTech) => !!tech.last_login_at && !tech.must_change_password;

/**
 * As opções e a escolhida: a que a pessoa marcou (se ainda vale) ou a padrão, Manter → Link (e-mail que recebe, envio
 * ligado e validado) → Provisória.
 */
function useChoice(tech: ChoiceTech | undefined, mailEnabled: boolean | undefined, mode: "grant" | "reset") {
  const [picked, setPicked] = useState<PasswordChoiceKey | null>(null);
  const keep = mode === "grant" && !!tech && canKeep(tech);
  const lock = tech ? linkLock(tech, mailEnabled, mode === "reset") : "Carregando…";
  const allowed = (key: PasswordChoiceKey) => (key === "keep" ? keep : key === "link" ? !lock : true);
  const fallback: PasswordChoiceKey = keep
    ? "keep"
    : !lock && mailEnabled === true && !!tech?.email_verified_at
      ? "link"
      : "temp";
  const choice = picked && allowed(picked) ? picked : fallback;
  return { choice, setChoice: setPicked, keep, lock };
}

/** Cartões de rádio da senha (Liberar acesso e Redefinir senha). */
export function PasswordChoice({
  value,
  onChange,
  tech,
  keep,
  lock,
  disabled = false,
}: {
  value: PasswordChoiceKey;
  onChange: (value: PasswordChoiceKey) => void;
  tech: ChoiceTech;
  /** "Manter a senha dele" entra (só ao liberar o acesso de quem já tem senha própria). */
  keep: boolean;
  /** Por que o link não dá (null: dá). */
  lock: string | null;
  disabled?: boolean;
}) {
  const name = useId();
  const options: { key: PasswordChoiceKey; label: string; line: string; note?: string | null; locked?: string | null }[] = [
    ...(keep ? [{ key: "keep" as const, label: "Manter a senha dele", line: "Ele entra com a senha que já usa." }] : []),
    {
      key: "link",
      label: "Enviar link por e-mail",
      line: `Para ${tech.email}. Vale ${PASSWORD_RESET_HOURS} horas.`,
      note: !lock && tech.email_verified_at === null ? "E-mail ainda não validado." : null,
      locked: lock,
    },
    { key: "temp", label: "Gerar senha provisória", line: "Você manda pelo WhatsApp." },
  ];
  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="mb-1 text-xs font-semibold text-ink/80">Senha</legend>
      {options.map((o) => {
        const checked = value === o.key;
        return (
          <label
            key={o.key}
            className={clsx(
              "flex items-start gap-3 rounded-lg border p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus",
              o.locked ? "cursor-not-allowed opacity-70" : "cursor-pointer",
              checked ? "border-brand bg-nav-active" : "border-line hover:border-line-strong",
            )}
          >
            <input
              type="radio"
              name={name}
              value={o.key}
              checked={checked}
              disabled={!!o.locked}
              onChange={() => onChange(o.key)}
              className="mt-0.5 size-4 shrink-0 accent-[var(--brand)]"
            />
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-ink">{o.label}</span>
              <span className="block text-xs break-words text-ink-muted">{o.line}</span>
              {o.note ? <span className="block text-xs text-ink-muted">{o.note}</span> : null}
              {o.locked ? (
                <span
                  className={clsx(
                    "block text-xs",
                    o.locked === "Sem e-mail válido." ? "font-medium text-amber-800 dark:text-amber-300" : "text-ink-muted",
                  )}
                >
                  {o.locked}
                </span>
              ) : null}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

/** "E-mail não enviado: …" quando o link não saiu da fila (o envio desligado ou o e-mail que não recebe). */
function notSentText(queued: EmailQueued): string {
  return queued.status === "not_configured"
    ? "E-mail não enviado: envio de e-mail desligado."
    : "E-mail não enviado: sem e-mail válido.";
}

const useTechnician = (id: UUID) =>
  useQuery({
    queryKey: ["technicians", "one", id],
    queryFn: ({ signal }) => api.get<Technician>(`/technicians/${id}`, undefined, { signal }),
    staleTime: 30_000,
  });

// --------------------------------------------------------------------------- liberar o acesso

type GrantOutcome =
  | { kind: "already" }
  | { kind: "keep" }
  | { kind: "link"; queued: EmailQueued }
  | { kind: "temp"; result: TemporaryPassword };

/**
 * "Liberar acesso" de um técnico sem acesso ao app (em geral, parceiro que veio do Field Control e continua atendendo):
 * libera e, pela escolha, mantém a senha dele, manda o link de nova senha por e-mail ou gera a senha provisória (para
 * mandar pelo WhatsApp). Lê o técnico (acesso, e-mail, validação, último acesso e senha provisória).
 */
export function GrantAccessDialog({
  technician,
  onClose,
}: {
  technician: { id: UUID; name: string; phone?: string | null };
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const mailEnabled = useMailEnabled();
  const detail = useTechnician(technician.id);
  const tech = detail.data;
  const { choice, setChoice, keep, lock } = useChoice(tech, mailEnabled, "grant");
  // O acesso já foi liberado aqui (o "Tentar de novo" e o "Gerar senha provisória" só fazem a senha).
  const activated = useRef(false);
  const [notSent, setNotSent] = useState<string | null>(null);

  const grant = useMutation({
    mutationFn: async (picked: PasswordChoiceKey): Promise<GrantOutcome> => {
      // Outra tela (ou aba) pode ter liberado há pouco, com a lista ainda antiga: liberar de novo trocaria a senha que
      // o técnico acabou de receber e o tiraria do app.
      if (!activated.current) {
        const current = await api.get<Technician>(`/technicians/${technician.id}`);
        if (current.is_active) return { kind: "already" };
        await api.patch(`/technicians/${technician.id}`, { is_active: true });
        activated.current = true;
      }
      try {
        if (picked === "keep") return { kind: "keep" };
        if (picked === "link") {
          return { kind: "link", queued: await api.post<EmailQueued>(`/technicians/${technician.id}/password-reset-link`) };
        }
        return { kind: "temp", result: await api.post<TemporaryPassword>(`/technicians/${technician.id}/reset-password`) };
      } catch (error) {
        const what = picked === "link" ? "o link não saiu" : "a senha provisória não saiu";
        throw new Error(`O acesso foi liberado, mas ${what}: ${errorMessage(error)}`);
      }
    },
    onSuccess: (outcome) => {
      if (outcome.kind === "keep") {
        toast({ title: `Acesso de ${technician.name} liberado`, tone: "success" });
        onClose();
      } else if (outcome.kind === "link") {
        if (outcome.queued.status === "queued") {
          toast({
            title: `Acesso liberado. Link enviado para ${outcome.queued.to ?? tech?.email ?? "o e-mail dele"}`,
            description: `Vale ${PASSWORD_RESET_HOURS} horas.`,
            tone: "success",
          });
          onClose();
        } else {
          setNotSent(notSentText(outcome.queued));
          setChoice("temp");
        }
      }
    },
    // Mesmo com a senha falhando, o acesso pode já ter sido liberado: as telas releem nos dois casos.
    onSettled: () => refreshTechnicianViews(queryClient),
  });

  if (grant.data?.kind === "already") {
    return (
      <Dialog
        open
        size="sm"
        onClose={onClose}
        title={`${technician.name} já tem acesso ao app`}
        footer={
          <Button variant="primary" onClick={onClose}>
            Concluir
          </Button>
        }
      />
    );
  }

  if (grant.data?.kind === "temp") {
    return (
      <Dialog
        open
        onClose={onClose}
        title="Acesso liberado"
        footer={
          <Button variant="primary" onClick={onClose}>
            Concluir
          </Button>
        }
      >
        <TempPasswordPanel result={grant.data.result} />
      </Dialog>
    );
  }

  const status = tech?.operational_status ?? "active";
  const description = !tech
    ? undefined
    : status === "active"
      ? "Ele passa a entrar no app e a receber OS."
      : `Ele passa a entrar no app. Continua ${OPERATIONAL_STATUS[status].toLowerCase()}: não recebe OS.`;

  // O link não saiu, com o acesso já liberado: fica a senha provisória (ou concluir sem ela).
  if (notSent) {
    return (
      <Dialog
        open
        size="sm"
        onClose={onClose}
        busy={grant.isPending}
        title="Acesso liberado"
        footer={
          <>
            <Button onClick={onClose} disabled={grant.isPending}>
              Concluir
            </Button>
            <Button variant="primary" loading={grant.isPending} onClick={() => grant.mutate("temp")}>
              {grant.isPending ? null : <KeyRound className="size-4" />}
              Gerar senha provisória
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-ink">{notSent}</p>
          {grant.error ? <ErrorBox message={errorMessage(grant.error)} /> : null}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      size="sm"
      role="alertdialog"
      onClose={onClose}
      // Liberando: sair agora perderia a senha provisória da resposta.
      busy={grant.isPending}
      title={`Liberar o acesso de ${technician.name} ao app?`}
      description={description}
      footer={
        <>
          <Button onClick={onClose} disabled={grant.isPending}>
            Cancelar
          </Button>
          <Button variant="primary" loading={grant.isPending} disabled={!tech} onClick={() => grant.mutate(choice)}>
            {grant.isPending ? null : <KeyRound className="size-4" />}
            {grant.error ? "Tentar de novo" : "Liberar acesso"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {tech ? (
          <PasswordChoice value={choice} onChange={setChoice} tech={tech} keep={keep} lock={lock} disabled={grant.isPending} />
        ) : detail.error ? (
          <ErrorBox message={errorMessage(detail.error)} onRetry={() => void detail.refetch()} />
        ) : (
          <div role="status" className="flex flex-col gap-2">
            <span className="sr-only">Carregando</span>
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        )}
        {grant.error ? <ErrorBox message={errorMessage(grant.error)} /> : null}
      </div>
    </Dialog>
  );
}

// --------------------------------------------------------------------------- redefinir a senha

type ResetOutcome = { kind: "link"; queued: EmailQueued } | { kind: "temp"; result: TemporaryPassword };

/**
 * "Redefinir senha" (Credenciais): o link de nova senha por e-mail (vale 2 horas; a senha só muda quando ele define a
 * nova, e aí os acessos abertos caem) ou a senha provisória na hora (encerra as sessões abertas).
 */
export function ResetPasswordDialog({ tech, onClose }: { tech: Technician; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const mailEnabled = useMailEnabled();
  const { choice, setChoice, lock } = useChoice(tech, mailEnabled, "reset");
  const [notSent, setNotSent] = useState<string | null>(null);

  const reset = useMutation({
    mutationFn: async (picked: PasswordChoiceKey): Promise<ResetOutcome> =>
      picked === "link"
        ? { kind: "link", queued: await api.post<EmailQueued>(`/technicians/${tech.id}/password-reset-link`) }
        : { kind: "temp", result: await api.post<TemporaryPassword>(`/technicians/${tech.id}/reset-password`) },
    onSuccess: (outcome) => {
      if (outcome.kind === "temp") {
        queryClient.setQueryData(["technicians", "one", tech.id], outcome.result.technician);
        return;
      }
      if (outcome.queued.status === "queued") {
        toast({
          title: `Link enviado para ${outcome.queued.to ?? tech.email}`,
          description: `Vale ${PASSWORD_RESET_HOURS} horas.`,
          tone: "success",
        });
        onClose();
      } else {
        setNotSent(notSentText(outcome.queued));
        setChoice("temp");
      }
    },
    onSettled: () => refreshTechnicianViews(queryClient),
  });

  if (reset.data?.kind === "temp") {
    return (
      <Dialog
        open
        onClose={onClose}
        title="Senha redefinida"
        description="As sessões abertas do técnico foram encerradas."
        footer={
          <Button variant="primary" onClick={onClose}>
            Concluir
          </Button>
        }
      >
        <TempPasswordPanel result={reset.data.result} />
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      size="sm"
      role="alertdialog"
      onClose={onClose}
      // Gerando a provisória: sair agora perderia a senha da resposta.
      busy={reset.isPending}
      title={`Redefinir a senha de ${tech.name}?`}
      footer={
        <>
          <Button onClick={onClose} disabled={reset.isPending}>
            Cancelar
          </Button>
          <Button variant="primary" loading={reset.isPending} onClick={() => reset.mutate(choice)}>
            {reset.isPending ? null : <KeyRound className="size-4" />}
            {choice === "temp" && notSent ? "Gerar senha provisória" : "Redefinir senha"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <PasswordChoice value={choice} onChange={setChoice} tech={tech} keep={false} lock={lock} disabled={reset.isPending} />
        {notSent ? <p className="text-sm text-ink">{notSent}</p> : null}
        {reset.error ? <ErrorBox message={errorMessage(reset.error)} /> : null}
      </div>
    </Dialog>
  );
}
