// Perfil profissional em Configurações (Dias e horários, Transporte, Formação, Áreas de atuação, Aptidões e Ferramental)
// e as telas da gestão (Documentos e Currículo): o estado de cada tela (o cadastro da memória e a releitura do servidor;
// as da gestão pedem hasCadastroE2), a gravação no ar das listas (Aptidões, Formação, Formas de recebimento,
// Indisponibilidade e Documentos) e os catálogos que a central mantém em Configurações › Técnicos, só na memória: o
// ferramental (GET /technician-tools), as aptidões (GET /technician-skills) e as áreas de atuação (GET
// /technician-areas). O técnico recebe só os itens ativos, em ordem alfabética; do item, o app usa o id e o nome.
// Nada vai para o SQLite, o kv nem o SecureStore. Um catálogo lido vale 10 min (abrir a tela depois disso relê), puxar a
// tela relê na hora, e a troca de sessão (Sair ou outro técnico) apaga.

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ProfileLoad } from "../components/settings/ProfileGate";
import { api, ApiError, errorMessage } from "./api";
import { offlineFailure } from "./net";
import { hasTechnicalProfile, loadProfile, useProfile } from "./profile";
import { session } from "./session";
import type { MyProfile, TechCatalogItem, TechnicianTool } from "./types";

/** Servidor antigo (o cadastro vem sem o perfil técnico): o que as telas do Perfil profissional mostram no lugar. */
export const UNAVAILABLE = {
  title: "Indisponível no momento",
  description: "O servidor ainda não tem esta parte do cadastro. Tente de novo mais tarde.",
} as const;

/** "Sem internet" ao gravar uma lista (dentro da folha). */
export const OFFLINE_SAVE = "Sem internet. Conecte o aparelho para salvar.";

// --------------------------------------------------------------------------- a tela

/**
 * O que a tela mostra: o cadastro com o perfil técnico ("ready"); o servidor antigo, sem ele ("unavailable"); ou, sem
 * cadastro que sirva, a carga e o erro do ProfileGate.
 */
export type TechProfileGate =
  | { status: "ready"; profile: MyProfile }
  | { status: "unavailable" }
  | Exclude<ProfileLoad, { status: "ok" }>;

export interface TechProfileScreen {
  gate: TechProfileGate;
  /** Abriu com o cadastro da memória e a releitura falhou por erro do servidor (sem rede, o aviso de rede já fala). */
  stale: boolean;
  /** "Tentar de novo": volta a carregar. */
  retry: () => void;
  /** Puxar para atualizar: relê sem esconder o que está na tela. */
  refresh: () => void;
  refreshing: boolean;
}

/**
 * Abre com o cadastro da memória e relê do servidor (a leitura em andamento é compartilhada com as outras telas).
 * `requires`: o que a tela pede a mais do cadastro (hasCadastroE2 nas telas da gestão); com a leitura feita e ele falso
 * (o servidor de antes), "unavailable".
 */
export function useTechProfileScreen(requires?: (profile: MyProfile) => boolean): TechProfileScreen {
  const profile = useProfile();
  const [load, setLoad] = useState<ProfileLoad>({ status: "loading" });
  const [round, setRound] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let alive = true;
    loadProfile().then(
      () => {
        if (!alive) return;
        setLoad({ status: "ok" });
        setRefreshing(false);
      },
      async (error: unknown) => {
        const offline = await offlineFailure(error);
        if (!alive) return;
        setLoad({ status: "error", offline, message: errorMessage(error) });
        setRefreshing(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [round]);

  const retry = useCallback(() => {
    setLoad({ status: "loading" });
    setRound((n) => n + 1);
  }, []);

  const refresh = useCallback(() => {
    setRefreshing(true);
    setRound((n) => n + 1);
  }, []);

  let gate: TechProfileGate;
  if (hasTechnicalProfile(profile) && (!requires || requires(profile))) gate = { status: "ready", profile };
  else if (load.status === "error") gate = load;
  else if (profile && load.status === "ok") gate = { status: "unavailable" };
  else gate = { status: "loading" };

  const stale = gate.status === "ready" && load.status === "error" && !load.offline;
  return { gate, stale, retry, refresh, refreshing };
}

// --------------------------------------------------------------------------- gravação das listas

/**
 * As listas que gravam pela folha e pela lixeira, na fila das gravações: Aptidões, Formação e Indisponibilidade montam
 * o corpo do PATCH em saveProfileWith; Formas de recebimento ("payout") e Documentos ("documents") têm rotas próprias
 * (writeProfile).
 */
export type ListPart = "skills" | "education" | "payout" | "unavailability" | "documents";

/**
 * A gravação de uma lista: enquanto está no ar, incluir, editar e excluir ficam desligados e o item que sai mostra o
 * carregando. Fica no módulo, e não na tela, para valer também depois de sair e voltar à tela no meio da gravação.
 */
export interface ListWrite {
  busy: boolean;
  /**
   * Os itens saindo: a aptidão pela chave (skillKey: o id do catálogo ou, no formato de antes, o nome sem acento e
   * maiúsculas); a formação, a forma de recebimento, o período e o documento pelo id.
   */
  removing: readonly string[];
}

const LIST_IDLE: ListWrite = { busy: false, removing: [] };
const ALL_IDLE: Record<ListPart, ListWrite> = {
  skills: LIST_IDLE,
  education: LIST_IDLE,
  payout: LIST_IDLE,
  unavailability: LIST_IDLE,
  documents: LIST_IDLE,
};
let listWrites: Record<ListPart, ListWrite> = ALL_IDLE;
/** Gravações no ar por lista (mais de uma só quando um toque passou antes de a tela desligar as ações). */
const listCount: Record<ListPart, number> = { skills: 0, education: 0, payout: 0, unavailability: 0, documents: 0 };
/** Quem gravou: a troca de sessão apaga, e o fim de uma gravação de antes dela não mexe mais em nada. */
let listOwner: string | null = null;
let listGeneration = 0;
const listListeners = new Set<() => void>();

function publishList(next: Record<ListPart, ListWrite>) {
  listWrites = next;
  listListeners.forEach((listener) => listener());
}

function subscribeList(listener: () => void) {
  listListeners.add(listener);
  return () => {
    listListeners.delete(listener);
  };
}

session.subscribe(() => {
  if (listOwner === null) return;
  const { status, user } = session.get();
  if (status === "signedIn" && user?.id === listOwner) return;
  listOwner = null;
  listGeneration += 1;
  for (const part of Object.keys(listCount) as ListPart[]) listCount[part] = 0;
  publishList(ALL_IDLE);
});

/**
 * Marca a lista como gravando enquanto `write` está no ar e devolve o que ele devolver. `removing`: o item que está
 * saindo (null ao incluir e ao editar).
 */
export async function trackListWrite<T>(part: ListPart, removing: string | null, write: () => Promise<T>): Promise<T> {
  const mine = listGeneration;
  listOwner = session.get().user?.id ?? null;
  listCount[part] += 1;
  const before = listWrites[part].removing;
  publishList({ ...listWrites, [part]: { busy: true, removing: removing === null ? before : [...before, removing] } });
  try {
    return await write();
  } finally {
    if (mine === listGeneration) {
      listCount[part] -= 1;
      const left = [...listWrites[part].removing];
      const at = removing === null ? -1 : left.indexOf(removing);
      if (at >= 0) left.splice(at, 1);
      publishList({ ...listWrites, [part]: listCount[part] > 0 ? { busy: true, removing: left } : LIST_IDLE });
    }
  }
}

/** A gravação no ar da lista, na tela (Aptidões, Formação, Formas de recebimento, Dias e horários ou Documentos). */
export function useListWrite(part: ListPart): ListWrite {
  const get = useCallback(() => listWrites[part], [part]);
  return useSyncExternalStore(subscribeList, get, get);
}

// --------------------------------------------------------------------------- catálogos na memória

/** Um catálogo lido vale este tempo: abrir a tela depois disso relê. */
const FRESH_MS = 10 * 60_000;

export interface CatalogError {
  offline: boolean;
  /** 404: o servidor ainda não tem a rota (API antiga). */
  missing: boolean;
  message: string;
}

export interface CatalogState<T> {
  /** null: ainda não leu (ou a leitura falhou sem nada guardado). */
  data: T | null;
  loading: boolean;
  /** A última leitura falhou; com `data`, a tela segue com o que tinha. */
  error: CatalogError | null;
}

interface Catalog<T> {
  subscribe: (listener: () => void) => () => void;
  get: () => CatalogState<T>;
  load: (options?: { force?: boolean }) => Promise<void>;
}

const NOTHING: CatalogState<never> = { data: null, loading: false, error: null };

function createCatalog<T>(read: () => Promise<T>): Catalog<T> {
  let current: CatalogState<T> = NOTHING;
  /** Quando foi lido (ms) e para quem: a troca de sessão apaga. */
  let at = 0;
  let owner: string | null = null;
  let inflight: Promise<void> | null = null;
  /** Sobe na troca de sessão: a resposta de uma leitura de antes não entra. */
  let generation = 0;
  const listeners = new Set<() => void>();

  function publish(next: CatalogState<T>) {
    current = next;
    listeners.forEach((listener) => listener());
  }

  session.subscribe(() => {
    if (owner === null) return;
    const { status, user } = session.get();
    if (status === "signedIn" && user?.id === owner) return;
    owner = null;
    at = 0;
    inflight = null;
    generation += 1;
    publish(NOTHING);
  });

  function load({ force = false }: { force?: boolean } = {}): Promise<void> {
    if (inflight) return inflight;
    if (!force && current.data !== null && Date.now() - at < FRESH_MS) return Promise.resolve();
    owner = session.get().user?.id ?? null;
    const mine = generation;
    publish({ data: current.data, loading: true, error: null });
    const run = read()
      .then(
        (data) => {
          if (mine !== generation) return;
          at = Date.now();
          publish({ data, loading: false, error: null });
        },
        async (error: unknown) => {
          const offline = await offlineFailure(error);
          if (mine !== generation) return;
          const missing = error instanceof ApiError && error.status === 404;
          publish({ data: current.data, loading: false, error: { offline, missing, message: errorMessage(error) } });
        },
      )
      .finally(() => {
        if (inflight === run) inflight = null;
      });
    inflight = run;
    return run;
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get: () => current,
    load,
  };
}

/** O catálogo na tela: lê ao abrir quando ainda não leu ou quando passou de 10 min. */
function useCatalog<T>(catalog: Catalog<T>): CatalogState<T> {
  const state = useSyncExternalStore(catalog.subscribe, catalog.get, catalog.get);
  useEffect(() => {
    void catalog.load();
  }, [catalog]);
  return state;
}

/** Só os itens ativos (o servidor já manda assim para o técnico; é por garantia). */
const activeOnly = <T extends { is_active?: boolean | null }>(items: T[]): T[] =>
  Array.isArray(items) ? items.filter((item) => item.is_active !== false) : [];

const toolCatalog = createCatalog(() => api.get<TechnicianTool[]>("/technician-tools"));
const skillCatalog = createCatalog(() => api.get<TechCatalogItem[]>("/technician-skills").then(activeOnly));
const areaCatalog = createCatalog(() => api.get<TechCatalogItem[]>("/technician-areas").then(activeOnly));

/** O ferramental (só as ativas), para a tela Ferramental. */
export function useToolCatalog(): CatalogState<TechnicianTool[]> {
  return useCatalog(toolCatalog);
}

/** Relê o ferramental agora: puxar a tela, "Tentar de novo" ou uma ferramenta que a central desativou. */
export function reloadToolCatalog(): Promise<void> {
  return toolCatalog.load({ force: true });
}

/**
 * As aptidões da central (só as ativas), para a folha "Adicionar aptidão". O servidor de antes da gestão não tem a rota:
 * o erro vem com `missing` (404) e a folha diz que a lista ainda não existe.
 */
export function useSkillCatalog(): CatalogState<TechCatalogItem[]> {
  return useCatalog(skillCatalog);
}

/** Relê as aptidões agora: puxar a tela, "Tentar de novo" ou uma aptidão que a central desativou ou excluiu. */
export function reloadSkillCatalog(): Promise<void> {
  return skillCatalog.load({ force: true });
}

/** As áreas de atuação da central (só as ativas), para a tela Áreas de atuação. */
export function useAreaCatalog(): CatalogState<TechCatalogItem[]> {
  return useCatalog(areaCatalog);
}

/** Relê as áreas de atuação agora: puxar a tela, "Tentar de novo" ou uma área que a central desativou ou criou. */
export function reloadAreaCatalog(): Promise<void> {
  return areaCatalog.load({ force: true });
}
