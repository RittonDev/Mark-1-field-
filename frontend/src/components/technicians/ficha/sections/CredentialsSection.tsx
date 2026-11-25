"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { KeyRound, Mail, ShieldOff, UserCheck } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useConfirm } from "@/components/Confirm";
import { useToast } from "@/components/Toaster";
import { Button, ErrorBox, Skeleton } from "@/components/ui";
import { useNow } from "@/components/useNow";
import { api, errorMessage } from "@/lib/api";
import { APP_ACCESS, isSendableEmail } from "@/lib/constants";
import { formatDate, formatRelative, formatShort } from "@/lib/format";
import { useMailEnabled } from "@/lib/queries";
import { EMAIL_TEMPLATE_LABEL, emailStatusLabel, technicianHref } from "@/lib/technicians";
import type { EmailLog, EmailQueued, Technician } from "@/lib/types";
import { GrantAccessDialog, ResetPasswordDialog } from "../../GrantAccessDialog";
import { refreshTechnicianViews } from "../../refresh";
import { fichaLabel } from "../FichaNav";
import { apiErrorText, SectionCard, SubTitle } from "../SectionCard";

const AMBER_TEXT = "text-amber-800 dark:text-amber-300";
/** Quantos e-mails a seção mostra (os mais novos). */
const EMAILS_SHOWN = 5;

/**
 * A situação do e-mail de login gravado: "Validado em dd/mm/aaaa" | "Validação pendente" (neutro) | "Sem e-mail
 * válido." (âmbar: o importado que não recebe), e a troca pedida no app. API antiga (sem a validação): nada.
 */
export function EmailState({ tech, children }: { tech: Technician; children?: React.ReactNode }) {
  const sendable = isSendableEmail(tech.email);
  const known = tech.email_verified_at !== undefined;
  if (sendable && !known && !tech.email_pending && !children) return null;
  return (
    <div className="flex flex-col gap-0.5 text-xs">
      {!sendable ? (
        <p className={clsx("font-medium", AMBER_TEXT)}>Sem e-mail válido.</p>
      ) : known ? (
        <p className="text-ink-muted">
          {tech.email_verified_at ? `Validado em ${formatDate(tech.email_verified_at)}` : "Validação pendente"}
        </p>
      ) : null}
      {tech.email_pending ? <p className="break-words text-ink-muted">Troca pedida no app: {tech.email_pending}</p> : null}
      {children}
    </div>
  );
}

/** "Validação de e-mail · 25/11, 14:30 · Enviado" (os mais novos primeiro). */
function SentEmails({ tech, mailEnabled }: { tech: Technician; mailEnabled: boolean | undefined }) {
  const emails = useQuery({
    queryKey: ["technicians", "emails", tech.id],
    queryFn: ({ signal }) => api.get<EmailLog[]>(`/technicians/${tech.id}/emails`, { limit: EMAILS_SHOWN }, { signal }),
    staleTime: 30_000,
  });
  const login = tech.email.toLowerCase();
  return (
    <div className="flex flex-col gap-2">
      {mailEnabled === false ? (
        <p className="text-sm text-ink-muted">Envio de e-mail desligado: use o WhatsApp e a senha provisória.</p>
      ) : null}
      {emails.isLoading ? (
        <Skeleton className="h-10 w-full" />
      ) : emails.error ? (
        <ErrorBox message={apiErrorText(emails.error)} onRetry={() => void emails.refetch()} />
      ) : !emails.data?.length ? (
        <p className="text-sm text-ink-muted">Nenhum e-mail enviado.</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {emails.data.slice(0, EMAILS_SHOWN).map((e) => (
            <li key={e.id} className="break-words text-ink">
              {EMAIL_TEMPLATE_LABEL[e.template] ?? e.template} · <time dateTime={e.created_at}>{formatShort(e.created_at)}</time> ·{" "}
              <span className={e.status === "failed" ? "font-medium text-red-700 dark:text-red-400" : "text-ink-muted"}>
                {emailStatusLabel(e.status, mailEnabled)}
              </span>
              {e.to_email.toLowerCase() !== login ? <span className="text-ink-muted"> · para {e.to_email}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Credenciais: o acesso ao app (liberar e cortar), o e-mail de login e a validação, a senha (link por e-mail ou senha
 * provisória) e os e-mails que o sistema mandou. As ações pedem Editar.
 */
export function CredentialsSection({ tech, canEdit }: { tech: Technician; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const mailEnabled = useMailEnabled();
  const now = useNow(60_000);
  const [granting, setGranting] = useState(false);
  const [resetting, setResetting] = useState(false);

  const cut = useMutation({
    mutationFn: () => api.patch<Technician>(`/technicians/${tech.id}`, { is_active: false }),
    onSuccess: (saved) => {
      queryClient.setQueryData(["technicians", "one", saved.id], saved);
      toast({ title: `Acesso de ${tech.name} cortado`, tone: "success" });
    },
    onError: (error) => toast({ title: "O acesso continua liberado", description: errorMessage(error), tone: "error" }),
    onSettled: () => refreshTechnicianViews(queryClient),
  });
  const verify = useMutation({
    mutationFn: () => api.post<EmailQueued>(`/technicians/${tech.id}/email-verification`),
    onSuccess: (queued) => {
      const to = queued.to ?? tech.email_pending ?? tech.email;
      if (queued.status === "queued") toast({ title: `Validação enviada para ${to}`, tone: "success" });
      else if (queued.status === "not_configured") toast({ title: "E-mail não enviado: envio de e-mail desligado", tone: "error" });
      else toast({ title: "E-mail não enviado: sem e-mail válido", description: "Corrija em Contato.", tone: "error" });
    },
    onError: (error) => toast({ title: apiErrorText(error), tone: "error" }),
    onSettled: () => refreshTechnicianViews(queryClient),
  });

  const askCut = async () => {
    const open = tech.open_tickets;
    const ok = await confirm({
      tone: "danger",
      title: `Cortar o acesso de ${tech.name} ao app?`,
      description: `Ele sai do app na hora e deixa de receber OS. As ofertas em aberto para ele são canceladas.${
        open === 1 ? " A OS aberta dele continua com ele." : open > 1 ? ` As ${open} OS abertas continuam com ele.` : ""
      }`,
      confirmLabel: "Cortar acesso",
    });
    if (ok) cut.mutate();
  };

  const sendable = isSendableEmail(tech.email);
  const pendingSendable = !!tech.email_pending && isSendableEmail(tech.email_pending);
  // Reenviar: o e-mail novo pedido no app ou o login ainda não validado (que recebe). API antiga (sem a validação): não.
  const canResend =
    canEdit &&
    mailEnabled !== false &&
    tech.email_verified_at !== undefined &&
    (pendingSendable || (sendable && !tech.email_verified_at));

  return (
    <SectionCard title={fichaLabel("credenciais")}>
      <section className="flex flex-col gap-2">
        <SubTitle>Acesso ao app</SubTitle>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-semibold text-ink">Acesso ao app: {tech.is_active ? APP_ACCESS.on : APP_ACCESS.off}</p>
          {canEdit ? (
            tech.is_active ? (
              <Button
                size="sm"
                variant="ghost"
                loading={cut.isPending}
                onClick={() => void askCut()}
                className="text-red-700 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300"
              >
                {cut.isPending ? null : <ShieldOff className="size-3.5" />}
                Cortar acesso
              </Button>
            ) : (
              <Button size="sm" variant="primary" onClick={() => setGranting(true)}>
                <UserCheck className="size-3.5" />
                Liberar acesso
              </Button>
            )
          ) : null}
        </div>
        <ul className="flex flex-col gap-0.5 text-xs text-ink-muted">
          <li>{tech.last_login_at ? `Último acesso ${formatRelative(tech.last_login_at, now)}` : "Nunca acessou"}</li>
          {tech.must_change_password ? <li className={clsx("font-medium", AMBER_TEXT)}>Senha provisória</li> : null}
          <li>
            {tech.location_consent_at ? `Autorizou o GPS em ${formatDate(tech.location_consent_at)}` : "Ainda não autorizou o GPS"}
          </li>
        </ul>
      </section>

      <section className="flex flex-col gap-2 border-t border-line pt-5">
        <SubTitle>E-mail de login</SubTitle>
        <p className="text-sm font-medium break-words text-ink">{tech.email}</p>
        <EmailState tech={tech}>
          {!sendable ? (
            <Link
              href={technicianHref(tech.id, "contato")}
              replace
              scroll={false}
              className="self-start rounded font-semibold text-ink underline-offset-2 hover:text-brand hover:underline focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
            >
              Corrigir em Contato
            </Link>
          ) : null}
        </EmailState>
        {canResend ? (
          <Button size="sm" className="self-start" loading={verify.isPending} onClick={() => verify.mutate()}>
            {verify.isPending ? null : <Mail className="size-3.5" />}
            Reenviar validação
          </Button>
        ) : null}
      </section>

      {/* Só com Editar: sem ação, o bloco não teria o que mostrar (a senha provisória já aparece no acesso). */}
      {canEdit ? (
        <section className="flex flex-col gap-2 border-t border-line pt-5">
          <SubTitle>Senha</SubTitle>
          <Button size="sm" className="self-start" onClick={() => setResetting(true)}>
            <KeyRound className="size-3.5" />
            Redefinir senha
          </Button>
        </section>
      ) : null}

      <section className="flex flex-col gap-2 border-t border-line pt-5">
        <SubTitle>E-mails enviados</SubTitle>
        <SentEmails tech={tech} mailEnabled={mailEnabled} />
      </section>

      {granting ? (
        <GrantAccessDialog technician={{ id: tech.id, name: tech.name, phone: tech.phone }} onClose={() => setGranting(false)} />
      ) : null}
      {resetting ? <ResetPasswordDialog tech={tech} onClose={() => setResetting(false)} /> : null}
    </SectionCard>
  );
}
