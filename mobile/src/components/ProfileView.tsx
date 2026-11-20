// Aba Perfil (app/index.tsx, no cabeçalho da lista): quem é o técnico, o cartão herói com o total de atendimentos
// desde sempre (GET /me/stats, lib/stats.ts) e a patente (a medalha do elo com o nome da faixa em maiúsculas,
// lib/level.ts), a lista do Perfil e a versão do app. Só os números do próprio técnico.
//
// No foco da aba (e quando a internet volta): busca as estatísticas em silêncio quando não há nada guardado ou o
// guardado passou de 10 min, e o elo quando nada está guardado. Sem elo guardado, esqueleto enquanto a busca pode
// correr; "SEM ELO" só sem internet ou com a busca falhada (todo técnico tem faixa no servidor: sem linha é Bronze).

import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { locationConsentAt } from "../lib/account";
import { APP_VERSION } from "../lib/config";
import { LEVEL_MEDAL_SIZE, LEVEL_NONE_LABEL, LEVEL_TIER } from "../lib/constants";
import { useMyLevel } from "../lib/level";
import { useLogout } from "../lib/logout";
import { formatCount } from "../lib/monthBars";
import { openSync } from "../lib/navigation";
import { useProfile } from "../lib/profile";
import { useSession } from "../lib/session";
import { refreshStatsNow, STATS_PROFILE_MAX_AGE_MS, useMyStats } from "../lib/stats";
import { isOnline, refreshLevelNow, useSyncStatus } from "../lib/sync";
import { useSyncSummary } from "../lib/syncSummary";
import { useStyles, useTheme, type Palette } from "../theme/theme";
import { Avatar } from "./Avatar";
import { HeroHalf, HeroPair } from "./HeroPair";
import { LevelMedal } from "./LevelBadge";
import { MenuGroup, MenuRow } from "./MenuRow";
import { Skeleton } from "./Skeleton";
import { Text } from "./Text";

const statsAge = (at: string) => Date.now() - new Date(at).getTime();

export function ProfileView() {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const { user } = useSession();
  const profile = useProfile();
  const level = useMyLevel();
  const stats = useMyStats();
  const sync = useSyncStatus();
  const { leaving, leavingText, confirmLogout } = useLogout();
  // A última busca desta aba falhou: sem nada guardado, mostra "—" e "SEM ELO" em vez do esqueleto.
  const [statsFailed, setStatsFailed] = useState(false);
  const [levelFailed, setLevelFailed] = useState(false);
  const mounted = useRef(true);
  const online = isOnline(sync);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // O total: em silêncio, sem toast. Ao voltar de uma tela, o guardado de até 10 min vale.
  const statsAt = stats === undefined ? undefined : (stats?.at ?? null);
  useFocusEffect(
    useCallback(() => {
      if (statsAt === undefined || !online) return;
      if (statsAt && statsAge(statsAt) <= STATS_PROFILE_MAX_AGE_MS) return;
      void refreshStatsNow().then((result) => {
        if (mounted.current) setStatsFailed(!result.ok);
      });
    }, [statsAt, online]),
  );

  // O elo: só enquanto nada está guardado (depois, a rodada do sync cuida dele).
  const levelMissing = level === null;
  useFocusEffect(
    useCallback(() => {
      if (!levelMissing || !online) return;
      void refreshLevelNow().then((result) => {
        if (mounted.current) setLevelFailed(!result.ok);
      });
    }, [levelMissing, online]),
  );

  if (!user) return null;

  const team = user.team?.name;
  const role = team ? `Técnico parceiro · ${team}` : "Técnico parceiro";
  const consentAt = locationConsentAt(user);
  const tier = level ? level.data.tier : null;
  const tierLabel = tier ? LEVEL_TIER[tier].label : null;
  const atRisk = Boolean(level?.data.at_risk);
  const total = stats ? formatCount(stats.data.lifetime.services) : null;
  // Sem nada guardado: o esqueleto enquanto a busca pode correr; sem internet ou com a busca falhada, o vazio.
  const statsWaiting = stats === null && online && !statsFailed;
  const levelWaiting = level === undefined || (level === null && online && !levelFailed);

  const totalSpoken = total
    ? `Total de atendimentos: ${total}. Abre Estatísticas`
    : "Total de atendimentos ainda não carregado. Abre Estatísticas";
  const levelSpoken = tierLabel
    ? `Elo ${tierLabel}${atRisk ? ", em risco" : ""}. Abre Meu elo`
    : levelWaiting
      ? "Carregando o elo. Abre Meu elo"
      : "Sem elo ainda. Abre Meu elo";

  return (
    <View style={styles.wrap}>
      <View style={styles.identity} accessible accessibilityLabel={[user.name, "técnico parceiro", team].filter(Boolean).join(", ")}>
        <Avatar name={user.name} uri={profile?.avatar_url} size={64} />
        <View style={styles.identityText}>
          <Text style={styles.name} numberOfLines={2}>
            {user.name}
          </Text>
          <Text style={styles.role}>{role}</Text>
        </View>
      </View>

      <HeroPair
        left={
          <HeroHalf side="left" onPress={() => router.push("/estatisticas")} accessibilityLabel={totalSpoken}>
            {stats === undefined ? (
              // Lendo o aparelho (milissegundos): a metade fica com a altura, sem piscar esqueleto.
              <Text style={[styles.total, styles.invisible]} numberOfLines={1} maxFontSizeMultiplier={1.3}>
                {" "}
              </Text>
            ) : statsWaiting ? (
              <Skeleton width={72} height={32} radius={8} />
            ) : (
              <Text style={styles.total} numberOfLines={1} adjustsFontSizeToFit maxFontSizeMultiplier={1.3}>
                {total ?? "—"}
              </Text>
            )}
            <Text style={styles.caption}>Total de atendimentos</Text>
          </HeroHalf>
        }
        right={
          <HeroHalf side="right" onPress={() => router.push("/elo")} accessibilityLabel={levelSpoken}>
            {tier && tierLabel ? (
              <>
                <LevelMedal tier={tier} size={LEVEL_MEDAL_SIZE.profile} />
                <View style={styles.tierRow}>
                  <Text style={styles.tierName} numberOfLines={1} maxFontSizeMultiplier={1.3}>
                    {tierLabel}
                  </Text>
                  {atRisk ? <View style={[styles.dot, { backgroundColor: c.warning }]} /> : null}
                </View>
              </>
            ) : levelWaiting ? (
              <>
                <Skeleton width={LEVEL_MEDAL_SIZE.profile} height={LEVEL_MEDAL_SIZE.profile} radius={16} />
                <Skeleton width={48} height={12} />
              </>
            ) : (
              <>
                <LevelMedal tier={null} size={LEVEL_MEDAL_SIZE.profile} />
                <Text style={styles.tierName} numberOfLines={1} maxFontSizeMultiplier={1.3}>
                  {LEVEL_NONE_LABEL}
                </Text>
              </>
            )}
          </HeroHalf>
        }
      />

      <MenuGroup>
        <MenuRow icon="settings" label="Configurações" onPress={() => router.push("/configuracoes")} />
        <MenuRow icon="history" label="Histórico de atendimentos" onPress={() => router.push("/historico")} />
        <MenuRow icon="chart" label="Estatísticas" onPress={() => router.push("/estatisticas")} />
        <MenuRow
          icon="medal"
          label="Meu elo"
          value={tierLabel ? (atRisk ? "Em risco" : tierLabel) : null}
          valueTone={atRisk ? "warning" : "muted"}
          accessibilityLabel={tierLabel ? `Meu elo, ${tierLabel}${atRisk ? ", em risco" : ""}` : undefined}
          onPress={() => router.push("/elo")}
        />
        <SyncMenuRow />
        <MenuRow icon="shield" label="Aviso de privacidade" onPress={() => router.push("/privacidade")} />
        <MenuRow
          icon="pin"
          label="Termo de uso da localização"
          value={consentAt ? "Aceito" : "Não aceito"}
          onPress={() => router.push("/termo-rastreamento")}
        />
        <MenuRow icon="logout" label="Sair" variant="danger" loading={leaving} onPress={() => void confirmLogout()} />
      </MenuGroup>

      {leaving ? (
        <Text style={styles.leaving} accessibilityLiveRegion="polite">
          {leavingText}
        </Text>
      ) : null}

      <Text style={styles.version}>Versão {APP_VERSION}</Text>
    </View>
  );
}

/**
 * A linha Sincronização num componente próprio: só ela redesenha a cada mudança do sync (itens para enviar, rede,
 * ações recusadas), não o Perfil inteiro.
 */
function SyncMenuRow() {
  const summary = useSyncSummary();
  return (
    <MenuRow
      icon="sync"
      label="Sincronização"
      value={summary.value}
      valueTone={summary.valueTone}
      count={summary.count}
      accessibilityLabel={summary.accessibilityLabel}
      onPress={() => openSync()}
    />
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    wrap: { paddingHorizontal: 16, paddingTop: 10, gap: 14 },
    identity: { flexDirection: "row", alignItems: "center", gap: 14 },
    identityText: { flex: 1, gap: 2 },
    name: { fontSize: 18, fontWeight: "700", color: c.ink },
    role: { fontSize: 13, color: c.inkMuted },
    total: { fontSize: 32, fontWeight: "700", color: c.ink, letterSpacing: -0.5, textAlign: "center" },
    invisible: { opacity: 0 },
    caption: { fontSize: 13, fontWeight: "600", color: c.inkMuted, textAlign: "center" },
    tierRow: { flexDirection: "row", alignItems: "center", gap: 6, maxWidth: "100%" },
    tierName: {
      fontSize: 13,
      fontWeight: "700",
      color: c.inkMuted,
      letterSpacing: 1.2,
      textTransform: "uppercase",
      flexShrink: 1,
    },
    dot: { width: 7, height: 7, borderRadius: 4 },
    leaving: { fontSize: 13, fontWeight: "600", color: c.inkMuted, textAlign: "center" },
    version: { fontSize: 12, color: c.inkSubtle, textAlign: "center", paddingVertical: 8 },
  });
