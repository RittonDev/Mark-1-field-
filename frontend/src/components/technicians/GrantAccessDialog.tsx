"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, MessageCircle } from "lucide-react";
import { useRef, useState } from "react";
import { Button, buttonClassName, Dialog, ErrorBox } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import type { TemporaryPassword, UUID } from "@/lib/types";
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

/**
 * "Liberar acesso" de um técnico sem acesso ao app (em geral, parceiro que veio do Field Control e
 * continua atendendo): libera o acesso e gera a senha provisória, para mandar pelo WhatsApp.
 */
export function GrantAccessDialog({
  technician,
  onClose,
}: {
  technician: { id: UUID; name: string; phone?: string | null };
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const activated = useRef(false);
  const grant = useMutation({
    mutationFn: async (): Promise<TemporaryPassword | null> => {
      // Outra tela (ou aba) pode ter liberado há pouco, com a lista ainda antiga: liberar de novo
      // trocaria a senha que o técnico acabou de receber e o tiraria do app.
      // No "Tentar de novo" depois de a senha falhar, o acesso já foi liberado aqui: só falta a senha.
      if (!activated.current) {
        const current = await api.get<{ is_active: boolean }>(`/users/${technician.id}`);
        if (current.is_active) return null;
        await api.patch(`/technicians/${technician.id}`, { is_active: true });
        activated.current = true;
      }
      try {
        return await api.post<TemporaryPassword>(`/technicians/${technician.id}/reset-password`);
      } catch (error) {
        throw new Error(`O acesso foi liberado, mas a senha provisória não saiu: ${errorMessage(error)}`);
      }
    },
    // Mesmo com a senha falhando, o acesso pode já ter sido liberado: as telas releem nos dois casos.
    onSettled: () => refreshTechnicianViews(queryClient),
  });

  if (grant.isSuccess && !grant.data) {
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

  if (grant.data) {
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
        <TempPasswordPanel result={grant.data} />
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
      description="Ele passa a receber OS e entra no app com uma senha provisória."
      footer={
        <>
          <Button onClick={onClose} disabled={grant.isPending}>
            Cancelar
          </Button>
          <Button variant="primary" loading={grant.isPending} onClick={() => grant.mutate()}>
            {grant.isPending ? null : <KeyRound className="size-4" />}
            {grant.error ? "Tentar de novo" : "Liberar acesso"}
          </Button>
        </>
      }
    >
      {grant.error ? <ErrorBox message={errorMessage(grant.error)} /> : null}
    </Dialog>
  );
}
