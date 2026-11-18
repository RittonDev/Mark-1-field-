// Ofertas de OS com preço (docs/API.md, "Ofertas de OS"). A central manda uma OS ainda sem técnico, com o
// valor, para alguns técnicos; quem aceitar primeiro fica com ela. Não há contraproposta nem chat: a conversa
// com a central é pelo grupo de WhatsApp.
//
// - A lista (GET /me/offers) vem na rodada de sincronização (sync.ts) e fica no aparelho (kv), para Hoje
//   mostrar as pendentes também sem rede. É só o recorte do convite: serviço, escopo, formulários, bairro e
//   cidade, data e valor. Cliente, loja e endereço só chegam com a OS, depois do aceite, e as ofertas que
//   fecharam vêm mínimas do servidor (sem escopo, formulários e bairro). Tudo sai do aparelho com o resto dos
//   dados (resetLocalData) na troca de técnico e quando o acesso é retirado.
// - Responder é só online: quem aceita primeiro leva, e o servidor diz na hora se a OS ainda está livre.
// - Para aceitar, o técnico abre a oferta (o servidor grava a leitura) e lê o escopo ("Escopo lido", guardado
//   aqui por oferta).

import { getKv, getTicket, setKv, type DB } from "./db";
import { formatBRL } from "./expenses";
import { whenLabel } from "./field";
import { formatMinutes } from "./format";
import type { NewsItem } from "./notifications";
import { showToast } from "./toast";
import type { FieldOffer, FieldOfferTicket, OfferState, UUID } from "./types";

const STORE_KEY = "field_offers";

/** O que fica no aparelho, numa chave só: quem grava lê e grava junto, dentro da mesma transação. */
export interface OfferStore {
  /** A lista do servidor já veio neste aparelho (antes disso, nada é "oferta nova"). */
  listed: boolean;
  /** As pendentes e as que fecharam nas últimas 24 h, como o servidor mandou (a mais nova primeiro). */
  offers: FieldOffer[];
  /** Ofertas já avisadas: o "Nova oferta de OS" sai uma vez por oferta. */
  seen: UUID[];
  /** Ofertas em que o técnico abriu o escopo ("Escopo lido"): só então o app libera o aceite. */
  scope: UUID[];
}

const EMPTY: OfferStore = { listed: false, offers: [], seen: [], scope: [] };

async function readStore(db?: DB): Promise<OfferStore | null> {
  const raw = await getKv(STORE_KEY, db);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Partial<OfferStore> | null;
    if (!data || !Array.isArray(data.offers)) return null;
    return {
      listed: data.listed === true,
      offers: data.offers,
      seen: Array.isArray(data.seen) ? data.seen : [],
      scope: Array.isArray(data.scope) ? data.scope : [],
    };
  } catch {
    return null;
  }
}

function writeStore(db: DB, store: OfferStore): Promise<void> {
  return setKv(STORE_KEY, JSON.stringify(store), db);
}

/** As ofertas guardadas, para as telas (useLiveQuery); vazio antes da primeira busca. */
export async function loadOfferStore(): Promise<OfferStore> {
  return (await readStore()) ?? EMPTY;
}

// ───────────────────────────── estado e textos ─────────────────────────────

const timeOf = (iso: string) => new Date(iso).getTime();

/** O estado na tela: a pendente com o prazo vencido (relógio do servidor, `at`) já é "expired". */
export function offerState(offer: Pick<FieldOffer, "state" | "expires_at">, at: number): OfferState {
  return offer.state === "pending" && offer.expires_at && timeOf(offer.expires_at) <= at ? "expired" : offer.state;
}

/** As que esperam a resposta (pendentes e no prazo): a de prazo mais curto primeiro; sem prazo, a mais nova. */
export function pendingOffers(offers: FieldOffer[], at: number): FieldOffer[] {
  return offers
    .filter((offer) => offerState(offer, at) === "pending")
    .sort((a, b) => {
      const ta = a.expires_at ? timeOf(a.expires_at) : Infinity;
      const tb = b.expires_at ? timeOf(b.expires_at) : Infinity;
      return ta !== tb ? ta - tb : timeOf(b.created_at) - timeOf(a.created_at);
    });
}

/** Bairro, cidade e UF da loja ("Centro · Campinas/SP"): nunca o nome da loja nem o endereço. */
export function placeLine(ticket: Pick<FieldOfferTicket, "district" | "city" | "state">): string | null {
  const town = ticket.city && ticket.state ? `${ticket.city}/${ticket.state}` : (ticket.city ?? ticket.state);
  return [ticket.district, town].filter(Boolean).join(" · ") || null;
}

export interface Deadline {
  /** "15:30", "amanhã 09:00" ou "20/11 18:00". */
  due: string;
  /** "25min", "2h 10min"; no último minuto, "menos de 1 min". */
  left: string;
  /** Menos de 1 h para responder. */
  urgent: boolean;
}

/** Prazo para responder pelo relógio do servidor (`at`); null quando a central não deu prazo. */
export function deadlineInfo(offer: Pick<FieldOffer, "expires_at">, at: number): Deadline | null {
  if (!offer.expires_at) return null;
  const minutes = (timeOf(offer.expires_at) - at) / 60_000;
  return {
    due: whenLabel(offer.expires_at, at),
    left: minutes < 1 ? "menos de 1 min" : formatMinutes(minutes),
    urgent: minutes < 60,
  };
}

/** "R$ 90,00 · Instalação · Centro": valor, serviço e bairro, o que o convite do grupo diz. */
export function offerSummary(offer: FieldOffer): string {
  const ticket = offer.ticket;
  return [formatBRL(offer.amount), ticket.service_type?.name ?? ticket.title, ticket.district ?? ticket.city]
    .filter(Boolean)
    .join(" · ");
}

// ───────────────────────────── gravação ─────────────────────────────

const FINAL: OfferState[] = ["accepted", "declined", "cancelled"];

/**
 * O que o servidor diz de uma oferta não volta atrás: respondida ou cancelada não fica pendente de novo
 * (uma lista buscada antes da resposta e gravada depois dela não a desfaz), e a leitura fica.
 */
function settle(fresh: FieldOffer, known: FieldOffer | undefined): FieldOffer {
  if (!known) return fresh;
  if ((fresh.state === "pending" || fresh.state === "expired") && FINAL.includes(known.state)) return known;
  if (!fresh.viewed_at && known.viewed_at) return { ...fresh, viewed_at: known.viewed_at };
  return fresh;
}

export interface OfferListOutcome {
  /** A lista guardada mudou (as telas recarregam). */
  changed: boolean;
  /** Pendentes que o aparelho ainda não tinha avisado. */
  news: FieldOffer[];
  /** Esperavam a resposta do técnico e fecharam sem ela: outro técnico aceitou, a central cancelou... */
  closed: FieldOffer[];
  /** Busca antes do pull: ficou oferta para a busca depois do pull decidir (a central definiu o técnico). */
  held: boolean;
  /** As que esperam a resposta do técnico agora: a notificação das outras sai da bandeja. */
  pending: UUID[];
}

/**
 * Grava a lista da busca (GET /me/offers) e diz o que avisar. Roda dentro da transação da rodada: lê e grava
 * junto com o "Escopo lido" e as respostas que a tela da oferta grava. `at`: agora pelo relógio do servidor.
 * `early`: busca antes do pull, quando a OS em que a central pôs o técnico pode ainda não estar no aparelho.
 */
export async function applyOfferList(
  db: DB,
  list: FieldOffer[],
  userId: UUID,
  at: number,
  early = false,
): Promise<OfferListOutcome> {
  const current = await readStore(db);
  const known = new Map((current?.offers ?? []).map((offer) => [offer.id, offer]));
  const offers = list.map((offer) => settle(offer, known.get(offer.id)));
  const seen = new Set(current?.seen ?? []);
  // Primeira lista no aparelho (primeiro acesso, troca de técnico): as pendentes já aparecem em Hoje.
  const news = current?.listed ? offers.filter((offer) => offerState(offer, at) === "pending" && !seen.has(offer.id)) : [];
  const closed: FieldOffer[] = [];
  let held = false;
  for (const [index, offer] of offers.entries()) {
    const before = known.get(offer.id);
    if (!before || offerState(before, at) !== "pending" || offer.state !== "cancelled") continue;
    // Trocada por uma oferta nova da mesma OS: a nova chega com o próprio aviso.
    if (offer.cancel_reason === "replaced") continue;
    if (offer.cancel_reason === "assigned") {
      // A central pôs o próprio técnico na OS, como responsável ou na visita: o pull da rodada já avisou
      // ("Nova OS para você", "Você vai na visita da ...").
      const local = await getTicket(offer.ticket.id, db);
      if (local && (local.assignee?.id === userId || (local.helpers ?? []).some((h) => h.id === userId))) continue;
      // Antes do pull, essa OS pode ainda não ter chegado: fica a versão guardada, sem aviso, até a busca depois do pull.
      if (early) {
        offers[index] = before;
        held = true;
        continue;
      }
    }
    closed.push(offer);
  }
  const ids = new Set(offers.map((offer) => offer.id));
  const next: OfferStore = {
    listed: true,
    offers,
    seen: [...ids],
    scope: (current?.scope ?? []).filter((id) => ids.has(id)),
  };
  const changed = JSON.stringify(next) !== JSON.stringify(current);
  if (changed) await writeStore(db, next);
  return { changed, news, closed, held, pending: pendingOffers(offers, at).map((offer) => offer.id) };
}

/** Grava uma oferta que a tela leu do servidor (aberta ou recusada) sem esperar a próxima lista. */
export async function putOffer(db: DB, offer: FieldOffer): Promise<void> {
  const current = (await readStore(db)) ?? EMPTY;
  const known = current.offers.find((item) => item.id === offer.id);
  const next = settle(offer, known);
  await writeStore(db, {
    ...current,
    offers: known ? current.offers.map((item) => (item.id === offer.id ? next : item)) : [next, ...current.offers],
    // Aberta é vista: não sai depois como "Nova oferta de OS".
    seen: current.seen.includes(offer.id) ? current.seen : [...current.seen, offer.id],
  });
}

/**
 * Aceita pelo técnico. Fica só o mínimo, como o servidor manda nas que fecharam (sem escopo, formulários e
 * bairro): a OS inteira já está no aparelho, gravada com a resposta do aceite.
 */
export async function setOfferAccepted(db: DB, offerId: UUID, at: string): Promise<void> {
  const current = await readStore(db);
  if (!current) return;
  await writeStore(db, {
    ...current,
    offers: current.offers.map(
      (offer): FieldOffer =>
        offer.id === offerId
          ? {
              ...offer,
              state: "accepted",
              responded_at: offer.responded_at ?? at,
              ticket: { ...offer.ticket, description: null, forms: [], district: null },
            }
          : offer,
    ),
  });
}

/** O técnico abriu o escopo da oferta ("Escopo lido"). */
export async function setScopeRead(db: DB, offerId: UUID): Promise<void> {
  const current = (await readStore(db)) ?? EMPTY;
  if (current.scope.includes(offerId)) return;
  await writeStore(db, { ...current, scope: [...current.scope, offerId] });
}

/** Oferta que o servidor não reconhece mais para este técnico (404): sai do aparelho. */
export async function dropOffer(db: DB, offerId: UUID): Promise<void> {
  const current = await readStore(db);
  if (!current) return;
  await writeStore(db, {
    ...current,
    offers: current.offers.filter((offer) => offer.id !== offerId),
    scope: current.scope.filter((id) => id !== offerId),
  });
}

// ───────────────────────────── avisos ─────────────────────────────

function closedText(offer: FieldOffer): { title: string; description: string } {
  const code = offer.ticket.code;
  switch (offer.cancel_reason) {
    case "taken":
      return { title: `Outro técnico aceitou a ${code}`, description: "A oferta não está mais disponível." };
    case "central":
      return { title: `A central cancelou a oferta da ${code}`, description: "Dúvidas, fale com a central no grupo." };
    case "assigned":
      return { title: `${code} já tem técnico`, description: "A central definiu quem vai atender." };
    case "ticket_closed":
      return { title: `${code} foi encerrada pela central`, description: "A oferta não está mais disponível." };
    default:
      return { title: `A oferta da ${code} fechou`, description: "A oferta não está mais disponível." };
  }
}

/**
 * Aviso de oferta nova (o mesmo texto no toast, com o app na tela, e na notificação do sistema, fora dela): uma
 * oferta abre a oferta (a OS ainda não é do técnico); mais de uma vira um resumo que abre Hoje. `at`: agora pelo
 * relógio do servidor (prazo para responder).
 */
export function offerNewsItems(news: FieldOffer[], at: number): NewsItem[] {
  if (news.length > 1) {
    return [{ id: "news-offer-many", title: `${news.length} novas ofertas de OS`, body: "Veja em Hoje e responda.", home: true }];
  }
  return news.map((offer) => {
    const deadline = deadlineInfo(offer, at);
    const summary = offerSummary(offer);
    return {
      id: `news-offer-${offer.id}`,
      title: "Nova oferta de OS",
      body: deadline ? `${summary} · responder até ${deadline.due}` : summary,
      offerId: offer.id,
    };
  });
}

/**
 * Oferta que fechou sem o técnico responder (outro técnico aceitou, a central cancelou...): só toast, com o app na
 * tela. Mais de uma vira um resumo.
 */
export function announceClosedOffers(closed: FieldOffer[]) {
  if (closed.length === 1) {
    showToast(closedText(closed[0]).title, { description: closedText(closed[0]).description });
  } else if (closed.length > 1) {
    showToast(`${closed.length} ofertas fecharam`, { description: "Outro técnico aceitou ou a central cancelou." });
  }
}

// ───────────────────────────── busca na rodada ─────────────────────────────

/** Sem aviso do tempo real nem pedido do técnico, a lista é conferida de novo no máximo a cada minuto. */
const MAX_AGE_MS = 60_000;

let fetchedAt = 0;
/** Avisos do tempo real (ticket.offer) recebidos e os já atendidos por uma busca. */
let wanted = 0;
let served = 0;
/** O pedido que a última busca antes do pull deixou para a busca depois do pull (offersHeld). */
let heldMark = 0;

/**
 * Chegou um ticket.offer (oferta nova, aceita por outro, cancelada), ou um aviso pode ter se perdido (app
 * voltando à tela, rede ou tempo real voltando): a próxima rodada busca a lista.
 */
export function offersChanged() {
  wanted += 1;
}

/**
 * Uma busca antes do pull deixou oferta para a busca depois do pull decidir: pede essa busca. Outra busca antes
 * do pull deixaria de novo, então esse pedido não vale para ela (sem uma busca por foto no upload).
 */
export function offersHeld() {
  offersChanged();
  heldMark = wanted;
}

/**
 * A rodada busca a lista? Pedido do técnico, aviso do tempo real ou a última busca já tem 1 min. `early`: busca
 * antes do pull, que não atende o pedido deixado para a busca depois do pull.
 */
export function offersDue(manual: boolean, early = false): boolean {
  if (manual || Date.now() - fetchedAt >= MAX_AGE_MS) return true;
  return wanted - served > (early && heldMark > served ? 1 : 0);
}

/** Começo de uma busca: os avisos que ela atende (um aviso que chega durante a busca pede outra). */
export function offersFetchStart(): number {
  return wanted;
}

/** Busca terminada, ou recusada pelo servidor (tenta de novo daqui a 1 min). Falta de rede não conta. */
export function offersFetchDone(mark: number) {
  fetchedAt = Date.now();
  served = Math.max(served, mark);
}

/** Saiu da conta ou o aparelho foi limpo: a sessão seguinte busca já na primeira rodada. */
export function resetOffersState() {
  fetchedAt = 0;
  wanted = 0;
  served = 0;
  heldMark = 0;
}
