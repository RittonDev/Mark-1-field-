"use client";

import { OctagonAlert, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { Card, CardHeader, Skeleton } from "@/components/ui";
import { useCan } from "@/lib/permissions";
import { ProblemText } from "./figures";
import { ticketsListHref } from "./links";
import { CUSTOMER_GAP, intFmt, MIN_BASE, MIN_BASE_ROW, pctText, plural, share } from "./rules";
import type { CustomerPulse, HomeCustomers, Ratio } from "./types";

/** Quantos clientes a lista mostra. */
const TOP = 5;

/**
 * Os maiores clientes dos últimos 30 dias: participação nas OS, chegada no horário (em âmbar quando
 * fica bem abaixo da operação) e o prazo estourado. Os nomes só chegam da API.
 */
export function CustomersCard({ customers, operationOnTime }: { customers: HomeCustomers | null; operationOnTime: Ratio | null }) {
  // A operação só serve de régua com base suficiente.
  const operation = operationOnTime ? share(operationOnTime, MIN_BASE).pct : null;
  const top = customers?.top.slice(0, TOP) ?? [];
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Clientes"
        description={customers ? `Últimos 30 dias · ${plural(customers.active, "cliente", "clientes")}` : "Últimos 30 dias"}
      />
      {customers === null ? (
        <div className="flex flex-col gap-4 px-5 py-4" role="status" aria-label="Carregando os clientes">
          {[0, 1, 2].map((i) => (
            <div key={i}>
              <Skeleton className="h-3.5 w-2/3" />
              <Skeleton className="mt-2 h-1.5 w-full rounded-full" />
              <Skeleton className="mt-2 h-3 w-1/2" />
            </div>
          ))}
        </div>
      ) : top.length === 0 ? (
        <p className="px-5 py-4 text-sm text-ink-muted">Nenhuma OS nos últimos 30 dias.</p>
      ) : (
        <>
          <ul className="divide-y divide-line px-5">
            {top.map((c) => (
              <CustomerRow key={c.id} customer={c} entered={customers.entered} operation={operation} />
            ))}
          </ul>
          <Concentration customers={customers} />
        </>
      )}
    </Card>
  );
}

function CustomerRow({ customer: c, entered, operation }: { customer: CustomerPulse; entered: number; operation: number | null }) {
  // A ficha do cliente é da tela Clientes: sem acesso a ela, o nome fica só como texto.
  const canCustomers = useCan("base.customers");
  const onTime = share(c.on_time, MIN_BASE_ROW);
  // Âmbar só com as duas bases firmes e uma distância que não é ruído.
  const low = onTime.pct !== null && operation !== null && operation - onTime.pct >= CUSTOMER_GAP;
  const part = entered > 0 ? Math.min(100, (100 * c.created) / entered) : null;
  const onTimeText = `No horário ${onTime.pct !== null ? `${pctText(onTime.pct)} (${onTime.text})` : onTime.text}`;
  return (
    <li className="py-3">
      <div className="flex items-baseline justify-between gap-3">
        {canCustomers ? (
          <Link
            href={`/clientes/${c.id}`}
            className="min-w-0 truncate text-sm font-semibold text-ink underline-offset-2 hover:text-brand-ink hover:underline"
            title={c.name}
          >
            {c.name}
          </Link>
        ) : (
          <span className="min-w-0 truncate text-sm font-semibold text-ink" title={c.name}>
            {c.name}
          </span>
        )}
        <Link
          href={ticketsListHref(c.filters)}
          className="shrink-0 text-sm font-medium text-ink tabular-nums underline-offset-2 hover:text-brand-ink hover:underline"
          aria-label={`${intFmt(c.created)} OS de ${c.name} nos últimos 30 dias`}
        >
          {intFmt(c.created)} OS
        </Link>
      </div>
      {part !== null ? (
        <span
          role="img"
          aria-label={`${pctText(part)} das OS do período`}
          title={`${pctText(part)} das OS do período`}
          className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-surface-2"
        >
          <span className="grow-x block h-full rounded-full" style={{ width: `${part}%`, background: "var(--viz-1)" }} />
        </span>
      ) : null}
      {c.on_time.base > 0 || c.breached > 0 ? (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-muted tabular-nums">
          {c.on_time.base > 0 ? (
            low ? (
              <ProblemText tone="warning" icon={TriangleAlert} title={`Operação: ${pctText(operation ?? 0)}`}>
                {onTimeText}
                <span className="sr-only"> (bem abaixo da operação)</span>
              </ProblemText>
            ) : (
              <span>{onTimeText}</span>
            )
          ) : null}
          {c.breached > 0 ? (
            <ProblemText tone="danger" icon={OctagonAlert} href={c.breached_filters ? ticketsListHref(c.breached_filters) : null}>
              {intFmt(c.breached)} com prazo estourado
            </ProblemText>
          ) : null}
        </p>
      ) : null}
    </li>
  );
}

/** Rodapé: quanto a operação depende dos maiores clientes. */
function Concentration({ customers: c }: { customers: HomeCustomers }) {
  if (c.entered <= 0 || c.active < 2) return null;
  const portion = (n: number) => (c.entered >= MIN_BASE ? pctText((100 * n) / c.entered) : `${intFmt(n)} de ${intFmt(c.entered)}`);
  const first = c.top[0]?.created ?? 0;
  const three = c.top.slice(0, 3).reduce((sum, x) => sum + x.created, 0);
  return (
    <p className="border-t border-line px-5 py-2.5 text-xs text-ink-muted tabular-nums">
      Maior cliente: {portion(first)}
      {c.entered >= MIN_BASE ? " das OS" : " OS"}
      {c.active > 3 ? ` · 3 maiores: ${portion(three)}` : ""}
    </p>
  );
}
