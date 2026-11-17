"use client";

import { FilterX, Inbox, Plus, SearchX, ShieldCheck, TicketX, UserCheck } from "lucide-react";
import Link from "next/link";
import { Button, buttonClassName, EmptyState } from "@/components/ui";
import { STATUS } from "@/lib/constants";
import type { TicketStatus } from "@/lib/types";
import { type View, VIEWS } from "./params";

/** Lista vazia: diz por quê (identificador, busca, filtro ou a própria aba) e oferece o próximo passo. */
export function EmptyList({
  view,
  q,
  numberSearch,
  number,
  otherFilters,
  closedInOpenView,
  newHref,
  onClear,
  onAllViews,
}: {
  view: View;
  q: string;
  /** A busca é o nº de uma OS ("OS-16976"). */
  numberSearch: boolean;
  /** Identificador escolhido no filtro. */
  number: number | null;
  /** Há filtros em uso além do identificador. */
  otherFilters: boolean;
  /** Status finais escolhidos numa aba que só mostra OS em aberto (link feito à mão). */
  closedInOpenView: TicketStatus[];
  newHref: string;
  onClear: () => void;
  onAllViews: () => void;
}) {
  const viewLabel = VIEWS.find((v) => v.key === view)?.label ?? "";
  const anyFilter = otherFilters || number !== null;
  const clearButton = (
    <Button size="sm" onClick={onClear}>
      Limpar filtros
    </Button>
  );
  const newTicket = (
    <Link href={newHref} className={buttonClassName("primary", "sm")}>
      <Plus aria-hidden className="size-4" />
      Nova OS
    </Link>
  );
  if (closedInOpenView.length) {
    const names = closedInOpenView.map((s) => `“${STATUS[s].label}”`).join(", ");
    return (
      <EmptyState
        icon={<FilterX />}
        title={`${names} ${closedInOpenView.length === 1 ? "não aparece" : "não aparecem"} em “${viewLabel}”`}
        description="Esta aba mostra só OS em aberto."
        action={
          <Button size="sm" onClick={onAllViews}>
            Ver em Todas
          </Button>
        }
      />
    );
  }
  if (number !== null) {
    return (
      <EmptyState
        icon={<SearchX />}
        title={`Nenhuma OS com o identificador ${number}`}
        description={otherFilters || q ? "Os outros filtros e a busca também valem: confira se combinam com esta OS." : "Confira o número."}
        action={clearButton}
      />
    );
  }
  if (q) {
    // A aba limitou a busca (a OS pode estar fechada): oferece procurar em todas.
    const narrowed = view !== "todas" && !numberSearch;
    return (
      <EmptyState
        icon={<SearchX />}
        title={numberSearch ? `Nenhuma OS com o nº ${q}` : `Nada encontrado para “${q}”`}
        description={
          narrowed
            ? `A busca olhou só a aba “${viewLabel}”.`
            : anyFilter
              ? "A busca respeita os filtros em uso."
              : "Confira o que foi digitado ou busque por outra palavra: loja, cliente, cidade ou título."
        }
        action={
          narrowed ? (
            <Button size="sm" onClick={onAllViews}>
              Buscar em todas as OS
            </Button>
          ) : anyFilter ? (
            clearButton
          ) : undefined
        }
      />
    );
  }
  if (anyFilter) {
    return (
      <EmptyState
        icon={<FilterX />}
        title="Nenhuma OS com estes filtros"
        description={view !== "todas" ? `Olhando só a aba “${viewLabel}”.` : undefined}
        action={clearButton}
      />
    );
  }
  if (view === "sla") {
    return <EmptyState icon={<ShieldCheck />} title="Nenhuma OS com SLA violado agora" description="As OS em aberto estão dentro do prazo." />;
  }
  if (view === "sem_tecnico") return <EmptyState icon={<UserCheck />} title="Todas as OS em aberto têm técnico" />;
  if (view === "minhas") {
    return (
      <EmptyState
        icon={<Inbox />}
        title="Nenhuma OS em aberto com você"
        description="Aqui aparecem as OS da sua fila e as que você executa."
        action={newTicket}
      />
    );
  }
  if (view === "abertos") return <EmptyState icon={<Inbox />} title="Nenhuma OS em aberto" action={newTicket} />;
  return <EmptyState icon={<TicketX />} title="Nenhuma OS ainda" action={newTicket} />;
}
