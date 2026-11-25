"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useLeaveGuard } from "@/components/settings/shared";
import { useToast } from "@/components/Toaster";
import { api } from "@/lib/api";
import { useCan } from "@/lib/permissions";
import type { Technician } from "@/lib/types";
import { refreshTechnicianViews } from "../refresh";

/** Erros por campo (as chaves da tela e as de grupo, como "rg"); só depois do 1º Salvar. */
export type SectionErrors = Partial<Record<string, string>>;

export interface SectionFormOptions<V> {
  tech: Technician;
  /** O nome da seção (o do menu), no aviso de alterações não salvas. */
  label: string;
  /** Os valores da tela a partir do técnico (campo ausente na API antiga: vazio). */
  read: (t: Technician) => V;
  /** O corpo normalizado do PATCH: compara (o que mudou) e envia (só as chaves que mudaram). Vazio vira null. */
  body: (v: V) => Record<string, unknown>;
  validate?: (v: V) => SectionErrors;
  /** Toast depois de salvar. */
  savedTitle: string;
  savedDescription?: (changed: Record<string, unknown>, saved: Technician) => string | undefined;
  /** Pergunta antes de gravar (ex.: trocar o e-mail de login); false não grava. */
  confirm?: (changed: Record<string, unknown>) => Promise<boolean>;
}

export interface SectionFormState<V> {
  value: V;
  /** Os valores de quando a seção abriu (ou da última gravação). */
  base: V;
  set: <K extends keyof V>(key: K, value: V[K]) => void;
  patch: (values: Partial<V>) => void;
  errors: SectionErrors;
  dirty: boolean;
  /** Valida, pergunta (confirm) e grava; false quando a validação barrou. */
  submit: () => Promise<boolean>;
  /** Volta ao que está no servidor agora. */
  discard: () => void;
  saving: boolean;
  error: unknown;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Uma seção da ficha com Salvar próprio (PATCH /technicians/{id} só com o que mudou). Sem alteração, o que chega do
 * servidor (tempo real, outra tela) substitui a tela; com alteração, não: ninguém perde o que digitou. Com alteração e
 * Editar, sair da tela (link interno, Ctrl+K, aviso, recarregar, Sair) pergunta antes.
 */
export function useSectionForm<V extends object>(o: SectionFormOptions<V>): SectionFormState<V> {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const canEdit = useCan("base.technicians", "edit");
  const incoming = o.read(o.tech);
  const incomingKey = JSON.stringify(incoming);
  const [state, setState] = useState(() => ({ base: incoming, value: incoming, key: incomingKey }));
  const [tried, setTried] = useState(false);
  const dirty = !same(o.body(state.value), o.body(state.base));
  if (incomingKey !== state.key) {
    // O cadastro mudou no servidor: a tela acompanha só sem alteração pendente.
    setState(dirty ? { ...state, key: incomingKey } : { base: incoming, value: incoming, key: incomingKey });
  }
  useLeaveGuard(dirty && canEdit, `As mudanças de ${o.label} ainda não foram salvas.`);

  const save = useMutation({
    mutationFn: (changed: Record<string, unknown>) => api.patch<Technician>(`/technicians/${o.tech.id}`, changed),
    onSuccess: (saved, changed) => {
      queryClient.setQueryData(["technicians", "one", saved.id], saved);
      refreshTechnicianViews(queryClient);
      const next = o.read(saved);
      setState({ base: next, value: next, key: JSON.stringify(next) });
      setTried(false);
      toast({ title: o.savedTitle, description: o.savedDescription?.(changed, saved), tone: "success" });
    },
  });

  const submit = async (): Promise<boolean> => {
    if (save.isPending) return true;
    setTried(true);
    const problems = o.validate?.(state.value) ?? {};
    if (Object.values(problems).some(Boolean)) return false;
    const now = o.body(state.value);
    const before = o.body(state.base);
    const changed = Object.fromEntries(Object.entries(now).filter(([key, value]) => !same(value, before[key])));
    if (!Object.keys(changed).length) return true;
    if (o.confirm && !(await o.confirm(changed))) return true;
    save.mutate(changed);
    return true;
  };

  const discard = () => {
    const latest = o.read(o.tech);
    setState({ base: latest, value: latest, key: JSON.stringify(latest) });
    setTried(false);
    save.reset();
  };

  return {
    value: state.value,
    base: state.base,
    set: (key, value) => setState((s) => ({ ...s, value: { ...s.value, [key]: value } })),
    patch: (values) => setState((s) => ({ ...s, value: { ...s.value, ...values } })),
    errors: tried ? (o.validate?.(state.value) ?? {}) : {},
    dirty,
    submit,
    discard,
    saving: save.isPending,
    error: save.error,
  };
}
