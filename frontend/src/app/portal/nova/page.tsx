"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowLeft, CircleCheck, MapPin, Search, Send, Store } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Button, Card, EmptyState, ErrorBox, Field, Input, LoadingBlock, PageHeader, Spinner, Textarea } from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useDebounced } from "@/lib/hooks";
import { portalMemory, URGENCY_OPTIONS, usePortalMe } from "@/lib/portal";
import type { Level, PortalLocation, PortalRequestDetail } from "@/lib/types";

function storeLine(s: PortalLocation) {
  return [s.address, [s.city, s.state].filter(Boolean).join(" - ")].filter(Boolean).join(" · ");
}

/** Leva o foco para o título da confirmação assim que ela aparece (o leitor de tela anuncia o envio). */
function focusOnMount(element: HTMLElement | null) {
  element?.focus();
}

/**
 * Escolha da loja: a última usada já vem marcada; com muitas lojas, busca por nome, código ou cidade.
 * `single`: a empresa tem uma loja só (já escolhida, sem "Trocar").
 */
function StorePicker({
  value,
  onChange,
  total,
  single,
  labelledBy,
}: {
  value: PortalLocation | null;
  onChange: (s: PortalLocation | null) => void;
  total: number;
  single: boolean;
  labelledBy: string;
}) {
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 300);
  const stores = useQuery({
    queryKey: ["portal", "locations", q],
    queryFn: () => api.get<PortalLocation[]>("/portal/locations", { q: q || undefined }),
    enabled: value === null,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
  const list = stores.data ?? [];

  if (value) {
    return (
      <div role="group" aria-labelledby={labelledBy} className="flex items-start gap-3 rounded-lg border border-brand/30 bg-brand-soft/60 px-3 py-2.5">
        <Store className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink">
            {value.code ? <span className="mr-1.5 font-mono text-xs font-normal text-ink-muted">{value.code}</span> : null}
            {value.name}
          </p>
          {storeLine(value) ? <p className="truncate text-xs text-ink-muted">{storeLine(value)}</p> : null}
        </div>
        {single ? null : (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="shrink-0 rounded text-xs font-medium text-brand hover:underline focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none"
            aria-label={`Trocar a loja (${value.name})`}
          >
            Trocar
          </button>
        )}
      </div>
    );
  }

  return (
    <div role="group" aria-labelledby={labelledBy} className="flex flex-col gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-subtle" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            // Enter escolhe a loja quando a busca achou só uma; nunca envia a solicitação sem loja.
            if (e.key !== "Enter") return;
            e.preventDefault();
            if (list.length === 1) onChange(list[0]);
          }}
          placeholder="Nome, código ou cidade da loja"
          className="pl-9"
          aria-label="Buscar loja"
          autoFocus
        />
      </div>
      <div className={clsx("max-h-64 overflow-y-auto rounded-lg border border-line transition-opacity duration-150", stores.isPlaceholderData && "opacity-60")}>
        {stores.isLoading ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : stores.error ? (
          <p className="px-3 py-6 text-center text-sm text-red-600 dark:text-red-400">{errorMessage(stores.error)}</p>
        ) : list.length ? (
          <ul className="divide-y divide-line">
            {list.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onChange(s)}
                  className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
                >
                  <MapPin className="mt-0.5 size-4 shrink-0 text-ink-subtle" aria-hidden />
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
      {!q && list.length > 0 && total > list.length ? (
        <p className="text-xs text-ink-muted">
          Mostrando {list.length} de {total.toLocaleString("pt-BR")} lojas. Digite para achar as outras.
        </p>
      ) : null}
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
  const { user } = useAuth();
  const userId = user?.id ?? "";
  const me = usePortalMe();
  const storeLabel = useId();
  const [store, setStore] = useState<PortalLocation | null>(() => (userId ? portalMemory.lastLocation(userId) : null));
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [urgency, setUrgency] = useState<Level>("medium");
  const [contact, setContact] = useState(() => (userId ? portalMemory.lastContact(userId) : ""));
  const [reference, setReference] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  // Empresa com uma loja só: ela já vem escolhida.
  const single = me.data?.locations === 1;
  const onlyStore = useQuery({
    queryKey: ["portal", "locations", ""],
    queryFn: () => api.get<PortalLocation[]>("/portal/locations"),
    enabled: single && store === null,
    staleTime: 60_000,
  });
  const chosen = store ?? (single ? (onlyStore.data?.[0] ?? null) : null);

  const send = useMutation({
    mutationFn: (location: PortalLocation) =>
      api.post<PortalRequestDetail>("/portal/requests", {
        location_id: location.id,
        title: title.trim(),
        description: description.trim(),
        urgency,
        contact: contact.trim() || null,
        client_reference: reference.trim() || null,
      }),
    onSuccess: (_, location) => {
      if (userId) portalMemory.remember(userId, location, contact);
      void queryClient.invalidateQueries({ queryKey: ["portal", "requests"] });
    },
    onError: (error) => {
      // A loja lembrada saiu da empresa ou foi desativada: esquece e abre a escolha de novo.
      if (error instanceof ApiError && error.status === 422 && /loja não encontrada/i.test(error.message)) {
        if (userId) portalMemory.forgetLocation(userId);
        setStore(null);
      }
    },
  });

  const back = (
    <Link href="/portal" className="mb-4 inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink">
      <ArrowLeft className="size-4" />
      Solicitações
    </Link>
  );

  if (send.data) {
    const created = send.data;
    return (
      <Card className="animate-rise px-6 py-10 text-center">
        <div role="status">
          <CircleCheck className="mx-auto size-12 text-emerald-600 dark:text-emerald-400" aria-hidden />
          <h1 ref={focusOnMount} tabIndex={-1} className="mt-4 text-xl font-bold tracking-[-0.02em] text-ink outline-none">
            Solicitação enviada
          </h1>
          <p className="mt-1 font-mono text-sm text-ink-muted">{created.code}</p>
          <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-ink-muted">
            A central da Maxx vai analisar e combinar a visita na loja. Você acompanha tudo por aqui.
          </p>
        </div>
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

  if (me.isLoading) return <LoadingBlock rows={4} />;

  if (me.data?.locations === 0) {
    return (
      <div>
        {back}
        <PageHeader title="Nova solicitação" />
        <Card>
          <EmptyState
            icon={<Store />}
            title="Nenhuma loja cadastrada"
            description="Sua empresa ainda não tem lojas cadastradas no portal. Fale com a central da Maxx para incluir."
          />
        </Card>
      </div>
    );
  }

  return (
    <div>
      {back}
      <PageHeader title="Nova solicitação" description="Conte o que aconteceu. A central analisa e envia um técnico." />

      <Card className="p-5 sm:p-6">
        <form
          className="flex flex-col gap-5"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!chosen) return setLocalError("Escolha a loja.");
            if (title.trim().length < 3) return setLocalError("Diga em poucas palavras o que aconteceu.");
            setLocalError(null);
            send.mutate(chosen);
          }}
        >
          {/* Loja e urgência são escolhas com botões: o rótulo fica fora de <label> (senão o clique no
              cartão da loja ia para o "Trocar" e o clique no rótulo marcava "Pode esperar"). */}
          <div className="flex flex-col gap-1.5">
            <span id={storeLabel} className="text-xs font-semibold text-ink/80">
              Loja<span className="text-red-500"> *</span>
            </span>
            {single && !chosen && onlyStore.isLoading ? (
              <p className="flex h-9 items-center gap-2 text-sm text-ink-muted">
                <Spinner className="size-4" />
                Carregando a loja...
              </p>
            ) : (
              <StorePicker
                value={chosen}
                onChange={(s) => {
                  setStore(s);
                  setLocalError(null);
                }}
                total={me.data?.locations ?? 0}
                single={single}
                labelledBy={storeLabel}
              />
            )}
          </div>

          <Field label="O que aconteceu?" required>
            <Input
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setLocalError(null);
              }}
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

          <fieldset>
            <legend className="mb-1.5 text-xs font-semibold text-ink/80">Urgência</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {URGENCY_OPTIONS.map((option) => {
                const active = urgency === option.value;
                const high = option.value === "high";
                return (
                  <label
                    key={option.value}
                    className={clsx(
                      "cursor-pointer rounded-lg border px-3 py-2.5 transition-[border-color,background-color] duration-150 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand/45",
                      active
                        ? high
                          ? "border-red-300 bg-red-50 dark:border-red-500/40 dark:bg-red-500/10"
                          : "border-brand bg-brand-soft"
                        : "border-line bg-surface hover:border-line-strong",
                    )}
                  >
                    <input
                      type="radio"
                      name="urgency"
                      value={option.value}
                      checked={active}
                      onChange={() => setUrgency(option.value)}
                      className="sr-only"
                    />
                    <span className={clsx("block text-sm font-semibold", active && high ? "text-red-700 dark:text-red-300" : "text-ink")}>
                      {option.label}
                    </span>
                    <span className="mt-0.5 block text-xs text-ink-muted">{option.hint}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>

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
