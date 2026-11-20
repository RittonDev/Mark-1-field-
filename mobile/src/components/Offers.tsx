import { router } from "expo-router";
import { useMemo, useRef } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { areaQuery } from "../lib/address";
import { getServerOffsetMs } from "../lib/api";
import { useLiveQuery, useNow } from "../lib/changes";
import { OFFER_STATE } from "../lib/constants";
import { openAreaInMaps } from "../lib/device-actions";
import { formatBRL } from "../lib/expenses";
import { formatLongDate, formatMinutes, formatMinutesLong, visitTimeText } from "../lib/format";
import { deadlineInfo, loadOfferStore, pendingOffers, placeLine } from "../lib/offers";
import { showToast } from "../lib/toast";
import type { FieldOffer, FieldOfferTicket } from "../lib/types";
import { RADIUS, statusFill, useStyles, useTheme, type Palette } from "../theme/theme";
import { Icon, type IconName } from "./Icon";
import { PressableScale } from "./motion";
import { Text } from "./Text";
import { visitWindow } from "./ticket/InfoPanel";
import { Badge, Card, SectionTitle } from "./ui";

/** Dois toques rápidos não abrem a mesma oferta duas vezes. */
const DOUBLE_TAP_MS = 600;
/** O prazo para responder anda a cada 15 s: a oferta vencida sai da lista sozinha. */
const TICK_MS = 15_000;

/** Linha com ícone dos cartões (bairro, data, prazo) e da tela da oferta (prazo). `warning`: prazo curto. */
export function OfferLine({
  icon,
  text,
  tone = "muted",
  strong = false,
  size = 14,
}: {
  icon: IconName;
  text: string;
  tone?: "muted" | "warning";
  strong?: boolean;
  size?: number;
}) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const color = tone === "warning" ? c.warningInk : c.inkMuted;
  return (
    <View style={styles.line}>
      <Icon name={icon} size={size + 1} color={color} strokeWidth={tone === "warning" ? 2 : 1.8} />
      <Text style={[styles.lineText, { fontSize: size, color }, (strong || tone === "warning") && styles.lineStrong]}>{text}</Text>
    </View>
  );
}

/**
 * Linha da tela da oferta com a duração estimada (cronômetro; a ampulheta é o prazo para responder), a data por
 * extenso e a hora, numa linha que quebra. `at`: agora pelo relógio do servidor ("Hoje", "Amanhã"). Sem a duração (OS
 * sem estimativa, oferta guardada por uma versão antiga), o item some; sem agenda, "Data a combinar".
 */
export function OfferMeta({
  ticket,
  at,
}: {
  ticket: Pick<FieldOfferTicket, "scheduled_start" | "scheduled_end" | "estimated_minutes">;
  at: number;
}) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const minutes = ticket.estimated_minutes ?? null;
  const start = ticket.scheduled_start;
  const items: { icon: IconName; text: string; spoken: string }[] = [];
  if (minutes !== null && minutes > 0) {
    items.push({ icon: "timer", text: formatMinutes(minutes), spoken: `Duração estimada: ${formatMinutesLong(minutes)}` });
  }
  if (start) {
    const day = formatLongDate(start, at);
    const time = visitTimeText(start, ticket.scheduled_end, minutes);
    items.push({ icon: "calendar", text: day, spoken: `Data: ${day}` }, { icon: "clock", text: time, spoken: `Horário: ${time}` });
  } else {
    items.push({ icon: "calendar", text: "Data a combinar", spoken: "Data a combinar" });
  }
  return (
    <View style={styles.meta}>
      {items.map((item) => (
        <View key={item.icon} style={styles.metaItem} accessible accessibilityLabel={item.spoken}>
          <Icon name={item.icon} size={16} color={c.inkMuted} />
          <Text style={styles.metaText}>{item.text}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * "Área do atendimento" na oferta: o bairro e a cidade (o endereço completo só depois do aceite) e o botão que busca a
 * área no app de mapas. Sem cidade, não aparece. `answerable`: a oferta ainda espera a resposta.
 */
export function OfferArea({
  ticket,
  answerable,
}: {
  ticket: Pick<FieldOfferTicket, "district" | "city" | "state">;
  answerable: boolean;
}) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const query = areaQuery(ticket);
  const city = ticket.city?.trim();
  if (!query || !city) return null;
  const district = ticket.district?.trim() || null;
  const uf = ticket.state?.trim();
  const town = uf ? `${city} - ${uf}` : city;

  async function openMap(target: string) {
    try {
      await openAreaInMaps(target);
    } catch {
      showToast("Não foi possível abrir o mapa", { tone: "error" });
    }
  }

  return (
    <Card style={styles.area}>
      <View style={styles.areaText}>
        <SectionTitle>Área do atendimento</SectionTitle>
        <Text style={styles.areaMain}>{district ?? town}</Text>
        {district ? <Text style={styles.areaTown}>{town}</Text> : null}
        {answerable ? <Text style={styles.areaNote}>O endereço completo aparece depois do aceite.</Text> : null}
      </View>
      <Pressable
        onPress={() => void openMap(query)}
        accessibilityRole="button"
        accessibilityLabel="Ver a área no mapa"
        accessibilityHint="Abre o app de mapas com o bairro e a cidade"
        hitSlop={4}
        style={({ pressed }) => [styles.mapButton, pressed && { backgroundColor: c.surface3 }]}
      >
        <Icon name="map" size={20} color={c.brandInk} />
      </Pressable>
    </Card>
  );
}

/**
 * "Serviços" da oferta: uma OS tem um serviço. O cartão começa recolhido; abrir é o "Escopo lido" que libera o aceite
 * (guardado por oferta, com a hora). Na fechada, só o nome (o recorte mínimo não traz o escopo). Sem tipo de serviço,
 * o título da oferta.
 */
export function OfferServices({
  ticket,
  answerable,
  scopeRead,
  open,
  onToggle,
}: {
  ticket: Pick<FieldOfferTicket, "title" | "description" | "service_type">;
  answerable: boolean;
  scopeRead: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const name = ticket.service_type?.name.trim() || ticket.title;
  const description = ticket.description?.trim() || null;
  const icon = (
    <View style={styles.serviceIcon}>
      <Icon name="wrench" size={18} color={c.inkMuted} />
    </View>
  );

  return (
    <View>
      <SectionTitle
        accent
        right={
          answerable ? (
            <Text style={styles.count} accessibilityLabel={scopeRead ? "1 de 1 escopo lido" : "0 de 1 escopo lido"}>
              {scopeRead ? "1/1 lido" : "0/1 lido"}
            </Text>
          ) : undefined
        }
      >
        Serviços
      </SectionTitle>
      <Card style={styles.serviceCard}>
        {answerable ? (
          <>
            <Pressable
              onPress={onToggle}
              accessibilityRole="button"
              accessibilityLabel={`${name}, ${scopeRead ? "escopo lido" : "escopo não lido"}`}
              accessibilityHint={open ? "Esconde o escopo" : "Mostra o que deve ser feito na visita"}
              accessibilityState={{ expanded: open }}
              style={({ pressed }) => [styles.serviceHead, pressed && { opacity: 0.7 }]}
            >
              <View style={styles.serviceRow}>
                {icon}
                <Text style={styles.serviceName} numberOfLines={2}>
                  {name}
                </Text>
                {scopeRead ? <Badge label="Escopo lido" color={c.success} /> : null}
                <Icon name={open ? "chevronUp" : "chevronDown"} size={20} color={c.inkMuted} />
              </View>
              {!open ? (
                <Text style={styles.serviceHint}>
                  {scopeRead ? "Toque para ler de novo." : "Toque para ler o escopo. O aceite libera depois da leitura."}
                </Text>
              ) : null}
            </Pressable>
            {open ? (
              <Text style={styles.scope} selectable>
                {description ?? "A central não escreveu o escopo. Tire as dúvidas no grupo antes de aceitar."}
              </Text>
            ) : null}
          </>
        ) : (
          <View style={styles.serviceRow}>
            {icon}
            <Text style={styles.serviceName} numberOfLines={2}>
              {name}
            </Text>
          </View>
        )}
      </Card>
    </View>
  );
}

/**
 * "Ofertas para você", no topo de Hoje: as OS que a central mandou com o valor e que esperam a resposta do
 * técnico (pendentes e no prazo, pelo relógio do servidor). Some quando não há nenhuma. Tem a própria
 * consulta e o próprio relógio: só ela redesenha quando a lista ou o prazo mudam.
 */
export function OffersSection() {
  const styles = useStyles(makeStyles);
  const store = useLiveQuery(loadOfferStore);
  const now = useNow(TICK_MS);
  const at = now + getServerOffsetMs();
  const list = store?.offers;
  const offers = useMemo(() => pendingOffers(list ?? [], at), [list, at]);
  if (!offers.length) return null;
  return (
    <View style={styles.section}>
      <SectionTitle accent right={<Text style={styles.count}>{offers.length === 1 ? "1 oferta" : `${offers.length} ofertas`}</Text>}>
        Ofertas para você
      </SectionTitle>
      <Text style={styles.hint}>A central mandou com o valor. Quem aceitar primeiro fica com a OS.</Text>
      {offers.map((offer) => (
        <OfferCard key={offer.id} offer={offer} at={at} />
      ))}
    </View>
  );
}

/**
 * Cartão da oferta: valor em destaque, serviço, bairro e cidade, data da visita (ou "Data a combinar") e o
 * prazo para responder. Nada de cliente, loja ou endereço (só depois que o técnico estiver na OS). "Nova"
 * enquanto ele não abriu a oferta.
 */
function OfferCard({ offer, at }: { offer: FieldOffer; at: number }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const lastPress = useRef(0);
  const ticket = offer.ticket;
  const amount = formatBRL(offer.amount);
  const service = ticket.service_type?.name ?? null;
  const place = placeLine(ticket);
  const when = visitWindow(ticket, at) ?? "Data a combinar";
  const deadline = deadlineInfo(offer, at);
  const deadlineText = deadline ? `Responder até ${deadline.due}${deadline.urgent ? ` · faltam ${deadline.left}` : ""}` : null;
  const fresh = !offer.viewed_at;
  const label = [ticket.code, fresh ? "nova" : null, ticket.title, `você recebe ${amount}`, service, place, when, deadlineText]
    .filter(Boolean)
    .join(", ");

  function open() {
    const pressedAt = Date.now();
    if (pressedAt - lastPress.current < DOUBLE_TAP_MS) return;
    lastPress.current = pressedAt;
    router.push({ pathname: "/oferta/[id]", params: { id: offer.id } });
  }

  return (
    <PressableScale
      onPress={open}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Abre a oferta para ler o escopo e responder"
      style={styles.card}
      pressedStyle={{ backgroundColor: c.surface2 }}
    >
      <View style={[styles.accent, { backgroundColor: statusFill(OFFER_STATE.pending.color, c) }]} />
      <View style={styles.body}>
        <View style={styles.header}>
          <View style={styles.codeRow}>
            <Text style={styles.code} numberOfLines={1}>
              {ticket.code}
            </Text>
            {fresh ? <Badge label="Nova" color={c.primary} /> : null}
          </View>
          <Text style={styles.amount} numberOfLines={1}>
            {amount}
          </Text>
        </View>
        <Text style={styles.title} numberOfLines={2}>
          {ticket.title}
        </Text>
        {service ? (
          <Text style={styles.service} numberOfLines={1}>
            {service}
          </Text>
        ) : null}
        <View style={styles.lines}>
          {place ? <OfferLine icon="pin" text={place} /> : null}
          <OfferLine icon="calendar" text={when} />
          {deadlineText ? <OfferLine icon="hourglass" text={deadlineText} tone={deadline?.urgent ? "warning" : "muted"} strong /> : null}
        </View>
      </View>
    </PressableScale>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    section: { gap: 8 },
    count: { fontSize: 13, fontWeight: "600", color: c.inkMuted, fontVariant: ["tabular-nums"] },
    hint: { fontSize: 13, color: c.inkMuted, lineHeight: 18, marginTop: -6 },
    card: {
      flexDirection: "row",
      backgroundColor: c.surface,
      borderRadius: RADIUS.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
      overflow: "hidden",
      boxShadow: c.elevation,
    },
    accent: { width: 3 },
    body: { flex: 1, padding: 16, paddingLeft: 14, gap: 6 },
    header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
    codeRow: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 },
    code: { flexShrink: 1, fontSize: 12, fontWeight: "700", color: c.inkMuted, fontVariant: ["tabular-nums"], letterSpacing: 0.3 },
    amount: { fontSize: 20, fontWeight: "700", color: c.ink, fontVariant: ["tabular-nums"], letterSpacing: -0.3 },
    title: { fontSize: 16, fontWeight: "700", color: c.ink, lineHeight: 22 },
    service: { fontSize: 14, fontWeight: "600", color: c.inkMuted },
    lines: { gap: 4, marginTop: 2 },
    line: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
    lineText: { flex: 1, color: c.inkMuted, lineHeight: 19 },
    lineStrong: { fontWeight: "600" },
    // tela da oferta
    meta: { flexDirection: "row", flexWrap: "wrap", columnGap: 14, rowGap: 6 },
    metaItem: { flexDirection: "row", alignItems: "center", gap: 6 },
    metaText: { fontSize: 14, fontWeight: "600", color: c.ink },
    area: { flexDirection: "row", alignItems: "center", gap: 12 },
    areaText: { flex: 1, gap: 2 },
    areaMain: { fontSize: 16, fontWeight: "700", color: c.ink },
    areaTown: { fontSize: 14, color: c.inkMuted },
    areaNote: { fontSize: 12, color: c.inkMuted, lineHeight: 17, marginTop: 4 },
    mapButton: {
      width: 44,
      height: 44,
      borderRadius: 22,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.primarySoft,
    },
    serviceCard: { gap: 10 },
    serviceHead: { minHeight: 44, gap: 8, borderRadius: RADIUS.control },
    serviceRow: { flexDirection: "row", alignItems: "center", gap: 10 },
    serviceIcon: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.surface2,
    },
    serviceName: { flex: 1, fontSize: 15, fontWeight: "700", color: c.ink },
    serviceHint: { fontSize: 13, color: c.inkMuted, lineHeight: 18 },
    scope: { fontSize: 15, color: c.ink, lineHeight: 21 },
  });
