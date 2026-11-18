"use client";

import { Lock } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import { buttonClassName } from "@/components/ui";
import { homePath } from "@/lib/access";
import { useAuth } from "@/lib/auth";
import { useDocumentTitle } from "@/lib/hooks";
import { ACCESS_ITEM, useQueueScope } from "@/lib/permissions";
import type { AccessItemKey } from "@/lib/types";

/**
 * Tela amigável no lugar de uma página que o perfil não inclui ("Sem acesso a Pagamentos") ou de uma OS
 * de outra fila. Neutra (não é erro de quem abriu), com o caminho de volta. A API recusa do mesmo jeito
 * (403), então isto só explica o que aconteceu.
 */
export function NoAccess({
  kind,
  item,
  label,
  title: customTitle,
  action,
  as: Heading = "h1",
}: {
  /** "module": tela fora do perfil; "queue": OS (ou fila) de outro analista. */
  kind: "module" | "queue";
  /** Tela sem acesso (o nome sai do catálogo). */
  item?: AccessItemKey | null;
  /** Nome da tela, quando não há item (ex.: o que veio no 403). */
  label?: string;
  /** Título próprio (ex.: "Fila de outro analista" na Minha fila). */
  title?: string;
  /** Troca o botão padrão (ex.: "Fechar" no painel da OS). */
  action?: React.ReactNode;
  /** Nível do título: h1 quando ocupa a página; h2 dentro de uma tela com título próprio. */
  as?: "h1" | "h2";
}) {
  const { user } = useAuth();
  const queues = useQueueScope();
  const titleId = useId();
  const name = (item ? ACCESS_ITEM[item]?.label : null) ?? label ?? "esta tela";
  const title = customTitle ?? (kind === "module" ? `Sem acesso a ${name}` : "OS de outra fila");
  useDocumentTitle(title);

  const text =
    kind === "module"
      ? "Seu perfil de acesso não inclui esta tela."
      : `Seu acesso mostra só a sua fila${queues.unowned ? " e as OS sem analista" : ""}.`;

  const fallback =
    kind === "module" ? (
      <Link href={homePath(user?.role)} className={buttonClassName("primary")}>
        Ir para o início
      </Link>
    ) : (
      <Link href="/minha-fila" className={buttonClassName("primary")}>
        Voltar para a minha fila
      </Link>
    );

  return (
    <section
      aria-labelledby={titleId}
      className="mx-auto flex max-w-md animate-enter flex-col items-center gap-4 px-4 py-16 text-center sm:py-20"
    >
      <span aria-hidden className="flex size-12 items-center justify-center rounded-full bg-surface-2 text-ink-muted ring-1 ring-line">
        <Lock className="size-6" />
      </span>
      <div>
        <Heading id={titleId} className="text-lg font-bold tracking-[-0.02em] text-balance text-ink">
          {title}
        </Heading>
        <p
          className="mt-1 text-sm text-pretty text-ink-muted"
          title={kind === "module" ? "O acesso é liberado em Configuração > Usuários (perfis de acesso)." : undefined}
        >
          {text}
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">{action ?? fallback}</div>
    </section>
  );
}
