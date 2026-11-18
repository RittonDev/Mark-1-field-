import { router } from "expo-router";
import { useMemo, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { getServerOffsetMs } from "../lib/api";
import { useLiveQuery, useNow } from "../lib/changes";
import { OFFER_STATE } from "../lib/constants";
import { formatBRL } from "../lib/expenses";
import { deadlineInfo, loadOfferStore, pendingOffers, placeLine } from "../lib/offers";
import type { FieldOffer } from "../lib/types";
import { RADIUS, statusFill, useStyles, useTheme, type Palette } from "../theme/theme";
import { Icon, type IconName } from "./Icon";
import { PressableScale } from "./motion";
import { Text } from "./Text";
import { visitWindow } from "./ticket/InfoPanel";
import { Badge, SectionTitle } from "./ui";

/** Dois toques rápidos não abrem a mesma oferta duas vezes. */
const DOUBLE_TAP_MS = 600;
/** O prazo para responder anda a cada 15 s: a oferta vencida sai da lista sozinha. */
const TICK_MS = 15_000;

/** Linha com ícone dos cartões e da tela da oferta (bairro, data, prazo). `warning`: prazo curto. */
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
  });
