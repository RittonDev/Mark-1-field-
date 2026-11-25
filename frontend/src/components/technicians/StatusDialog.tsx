"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { useToast } from "@/components/Toaster";
import { Button, Checkbox, Dialog, ErrorBox, Field, Textarea } from "@/components/ui";
import { api } from "@/lib/api";
import type { OperationalStatus, OperationalStatusIn, Technician } from "@/lib/types";
import { apiErrorText } from "./ficha/SectionCard";
import { refreshTechnicianViews } from "./refresh";

/** Motivo: de 3 a 500 caracteres (a API recusa fora disso). */
const REASON_MIN = 3;
const REASON_MAX = 500;

const COPY: Record<
  OperationalStatus,
  { verb: string; title: (name: string) => string; text: string; done: (name: string) => string; tone: "danger" | "primary" }
> = {
  inactive: {
    verb: "Inativar",
    title: (name) => `Inativar ${name}?`,
    text: "Sai das sugestões, das ofertas e da escolha de técnico até ser reativado. As ofertas em aberto para ele são canceladas.",
    done: (name) => `${name} inativado`,
    tone: "danger",
  },
  blocked: {
    verb: "Bloquear",
    title: (name) => `Bloquear ${name}?`,
    text: "Não recebe mais OS: sai das sugestões, das ofertas e da escolha de técnico. As ofertas em aberto para ele são canceladas.",
    done: (name) => `${name} bloqueado`,
    tone: "danger",
  },
  active: {
    verb: "Reativar",
    title: (name) => `Reativar ${name}?`,
    text: "Volta a receber OS.",
    done: (name) => `${name} reativado`,
    tone: "primary",
  },
};

/**
 * Mudar a situação na operação (Ativo, Inativo, Bloqueado) com o motivo obrigatório, que vai para o histórico com quem e
 * quando. Bloquear sugere cortar também o acesso ao app (marcado). Reativar não devolve o acesso (é o "Liberar acesso"
 * de Credenciais). As OS abertas continuam com ele.
 */
export function StatusDialog({
  tech,
  target,
  onClose,
}: {
  tech: Technician;
  target: OperationalStatus;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [reason, setReason] = useState("");
  const [cutAccess, setCutAccess] = useState(true);
  const [tried, setTried] = useState(false);
  const copy = COPY[target];
  // Cortar o acesso só ao bloquear quem ainda entra no app.
  const offerCut = target === "blocked" && tech.is_active;
  const reasonProblem = reason.trim().length < REASON_MIN ? "Informe o motivo." : null;
  const open = tech.open_tickets;

  const change = useMutation({
    mutationFn: (input: OperationalStatusIn) => api.post<Technician>(`/technicians/${tech.id}/operational-status`, input),
    onSuccess: (saved, input) => {
      queryClient.setQueryData(["technicians", "one", saved.id], saved);
      refreshTechnicianViews(queryClient);
      toast({
        title: copy.done(tech.name),
        description: input.cut_access ? "O acesso ao app foi cortado." : undefined,
        tone: "success",
      });
      onClose();
    },
  });

  const submit = () => {
    setTried(true);
    if (reasonProblem || change.isPending) return;
    change.mutate({ status: target, reason: reason.trim(), ...(offerCut ? { cut_access: cutAccess } : {}) });
  };

  const text =
    target === "active" && !tech.is_active ? `${copy.text} Sem acesso ao app: libere em Credenciais.` : copy.text;

  return (
    <Dialog
      open
      onClose={onClose}
      // Com o motivo digitado, fechar pergunta antes; enviando, espera terminar.
      dirty={reason.trim().length > 0}
      busy={change.isPending}
      title={copy.title(tech.name)}
      description={text}
      footer={
        <>
          <Button onClick={onClose} disabled={change.isPending}>
            Cancelar
          </Button>
          <Button type="submit" form="status-dialog-form" variant={copy.tone} loading={change.isPending}>
            {copy.verb}
          </Button>
        </>
      }
    >
      <form
        id="status-dialog-form"
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {target !== "active" && open > 0 ? (
          <p className="text-sm text-ink">
            {/* As OS abertas abrem em outra aba: o diálogo (e o motivo digitado) fica. */}
            <Link
              href={`/chamados?assignee_id=${tech.id}&open_only=true`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-ink underline underline-offset-2 hover:text-brand"
            >
              {open === 1 ? "Ver a OS aberta dele" : `Ver as ${open} OS abertas dele`}
            </Link>
            {open === 1 ? " Ela continua com ele." : " Elas continuam com ele."}
          </p>
        ) : null}
        {offerCut ? <Checkbox label="Cortar também o acesso ao app" checked={cutAccess} onChange={setCutAccess} /> : null}
        <Field label="Motivo" required error={tried ? reasonProblem : null}>
          <Textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={REASON_MAX}
            autoFocus
            aria-invalid={tried && reasonProblem ? true : undefined}
          />
        </Field>
        {change.error ? <ErrorBox message={apiErrorText(change.error)} /> : null}
      </form>
    </Dialog>
  );
}
