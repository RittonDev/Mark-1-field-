"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowLeft, CheckCircle2, MapPin, Search, Send, Store } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDeferredValue, useState } from "react";
import { Button, Card, ErrorBox, Field, Input, PageHeader, Spinner, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { portalMemory, URGENCY_OPTIONS } from "@/lib/portal";
import type { Level, PortalLocation, PortalRequestDetail } from "@/lib/types";

function storeLine(s: PortalLocation) {
  return [s.address, [s.city, s.state].filter(Boolean).join(" - ")].filter(Boolean).join(" · ");
}

/** Escolha da loja: a última usada já vem marcada; com muitas lojas, busca por nome, código ou cidade. */
function StorePicker({ value, onChange }: { value: PortalLocation | null; onChange: (s: PortalLocation | null) => void }) {
  const [search, setSearch] = useState("");
  const q = useDeferredValue(search.trim());
  const stores = useQuery({
    queryKey: ["portal", "locations", q],
    queryFn: () => api.get<PortalLocation[]>("/portal/locations", { q: q || undefined }),
    enabled: value === null,
    staleTime: 60_000,
  });

  if (value) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-brand/30 bg-brand-soft/60 px-3 py-2.5">
        <Store className="mt-0.5 size-4 shrink-0 text-brand" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink">
            {value.code ? <span className="mr-1.5 font-mono text-xs font-normal text-ink-muted">{value.code}</span> : null}
            {value.name}
          </p>
          {storeLine(value) ? <p className="truncate text-xs text-ink-muted">{storeLine(value)}</p> : null}
        </div>
        <button type="button" onClick={() => onChange(null)} className="shrink-0 text-xs font-medium text-brand hover:underline">
          Trocar
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-subtle" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Nome, código ou cidade da loja"
          className="pl-9"
          aria-label="Buscar loja"
          autoFocus
        />
      </div>
      <div className="max-h-64 overflow-y-auto rounded-lg border border-line">
        {stores.isLoading ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : stores.data?.length ? (
          <ul className="divide-y divide-line">
            {stores.data.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onChange(s)}
                  className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-surface-2"
                >
                  <MapPin className="mt-0.5 size-4 shrink-0 text-ink-subtle" />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-ink">
                      {s.code ? <span className="mr-1.5 font-mono text-xs font-normal text-ink-muted">{s.code}</span> : null}
                      {s.name}
                    </span>
                    {storeLine(s) ? <span className="block truncate text-xs text-ink-muted">{storeLine(s)}</span> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-3 py-6 text-center text-sm text-ink-muted">Nenhuma loja encontrada.</p>
        )}
      </div>
    </div>
  );
}

/**
 * Nova solicitação: só o que a central precisa para agir (loja, o que aconteceu, urgência e com
 * quem falar). Nada de categoria, prioridade ou campos internos.
 */
export default function NewRequestPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [store, setStore] = useState<PortalLocation | null>(() => portalMemory.lastLocation());
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [urgency, setUrgency] = useState<Level>("medium");
  const [contact, setContact] = useState(() => portalMemory.lastContact());
  const [reference, setReference] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: () =>
      api.post<PortalRequestDetail>("/portal/requests", {
        location_id: store?.id,
        title: title.trim(),
        description: description.trim(),
        urgency,
        contact: contact.trim() || null,
        client_reference: reference.trim() || null,
      }),
    onSuccess: () => {
      if (store) portalMemory.remember(store, contact);
      void queryClient.invalidateQueries({ queryKey: ["portal", "requests"] });
    },
  });

  if (send.data) {
    const created = send.data;
    return (
      <Card className="animate-rise px-6 py-10 text-center">
        <CheckCircle2 className="mx-auto size-12 text-emerald-600 dark:text-emerald-400" />
        <h1 className="mt-4 text-xl font-bold tracking-[-0.02em] text-ink">Solicitação enviada</h1>
        <p className="mt-1 font-mono text-sm text-ink-muted">{created.code}</p>
        <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-ink-muted">
          A central da Maxx vai analisar e combinar a visita na loja. Você acompanha tudo por aqui.
        </p>
        <div className="mt-6 flex flex-col justify-center gap-2 sm:flex-row">
          <Button variant="primary" onClick={() => router.push(`/portal/${created.id}`)}>
            Acompanhar
          </Button>
          <Button
            onClick={() => {
              send.reset();
              setTitle("");
              setDescription("");
              setReference("");
              setUrgency("medium");
            }}
          >
            Abrir outra
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <div>
      <Link href="/portal" className="mb-4 inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink">
        <ArrowLeft className="size-4" />
        Solicitações
      </Link>
      <PageHeader title="Nova solicitação" description="Conte o que aconteceu. A central analisa e envia um técnico." />

      <Card className="p-5 sm:p-6">
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!store) return setLocalError("Escolha a loja.");
            if (title.trim().length < 3) return setLocalError("Diga em poucas palavras o que aconteceu.");
            setLocalError(null);
            send.mutate();
          }}
        >
          <Field label="Loja" required>
            <StorePicker value={store} onChange={setStore} />
          </Field>

          <Field label="O que aconteceu?" required>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Ex.: PDV 2 sem rede, impressora fiscal não liga"
              maxLength={200}
            />
          </Field>

          <Field label="Detalhes" hint="Desde quando, o que já tentaram, qual equipamento. Opcional.">
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              maxLength={5000}
              placeholder="Quanto mais detalhe, mais rápido a central resolve."
            />
          </Field>

          <Field label="Urgência">
            <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Urgência">
              {URGENCY_OPTIONS.map((option) => {
                const active = urgency === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setUrgency(option.value)}
                    className={clsx(
                      "rounded-lg border px-3 py-2.5 text-left transition-[border-color,background-color] duration-150",
                      active
                        ? option.value === "high"
                          ? "border-red-300 bg-red-50 dark:border-red-500/40 dark:bg-red-500/10"
                          : "border-brand bg-brand-soft"
                        : "border-line bg-surface hover:border-line-strong",
                    )}
                  >
                    <span className={clsx("block text-sm font-semibold", active && option.value === "high" ? "text-red-700 dark:text-red-300" : "text-ink")}>
                      {option.label}
                    </span>
                    <span className="mt-0.5 block text-xs text-ink-muted">{option.hint}</span>
                  </button>
                );
              })}
            </div>
          </Field>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Quem recebe o técnico" hint="Nome e telefone na loja.">
              <Input
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                placeholder="Ex.: Ana, gerente · (11) 99999-0000"
                maxLength={160}
              />
            </Field>
            <Field label="Nº do chamado de vocês" hint="Se tiver um sistema interno. Opcional.">
              <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Ex.: INC-1234" maxLength={80} />
            </Field>
          </div>

          {localError || send.error ? <ErrorBox message={localError ?? errorMessage(send.error)} /> : null}

          <div className="flex justify-end">
            <Button type="submit" variant="primary" size="lg" loading={send.isPending} className="w-full sm:w-auto">
              <Send className="size-4" />
              Enviar solicitação
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
