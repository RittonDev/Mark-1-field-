"use client";

import Link from "next/link";
import { type FichaSectionKey, technicianHref } from "@/lib/technicians";
import type { UUID } from "@/lib/types";

/**
 * Link para a ficha do técnico (/tecnicos/{id}, com a seção quando não é a padrão): um link real, então Ctrl/⌘+clique e
 * o botão do meio abrem outra aba. Dentro de uma linha ou cartão clicável, o clique fica só no link. `target="_blank"`
 * só onde a tela não guarda a busca na URL (Técnicos › Mais próximos).
 */
export function TechnicianLink({
  id,
  section,
  target,
  className,
  title,
  label,
  children,
}: {
  id: UUID;
  section?: FichaSectionKey | null;
  target?: "_blank";
  className?: string;
  title?: string;
  /** Nome para o leitor de tela quando o conteúdo é só um ícone ("Ver Tecnico Alfa"). */
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={technicianHref(id, section)}
      target={target}
      rel={target ? "noopener noreferrer" : undefined}
      className={className}
      title={title}
      aria-label={label}
      // A linha ou o cartão em volta pode ter o próprio clique (e o botão do meio): o do link vale sozinho.
      onClick={(e) => e.stopPropagation()}
      onAuxClick={(e) => e.stopPropagation()}
    >
      {children}
    </Link>
  );
}
