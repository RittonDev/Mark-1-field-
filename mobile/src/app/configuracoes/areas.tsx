// Áreas de atuação (Configurações › Perfil profissional): o técnico marca as áreas em que atende, do catálogo que a
// central mantém (Configurações › Técnicos, na central). É o que leva às sugestões de técnico para cada OS. Salva ao
// tocar, sem botão, como o Ferramental: os toques de perto vão juntos num envio só (sem rede, avisa e não muda); até
// 20 áreas. Área desativada na central com a tela aberta: o servidor ignora a marcação e a lista é relida (ela some);
// área marcada pela central que a lista ainda não tem: a lista é relida. Com muitas áreas, aparece a busca. Pede o
// servidor com a gestão (hasCadastroE2): sem ele, "Indisponível".

import { Stack } from "expo-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CadastroUnavailable } from "../../components/settings/CadastroUnavailable";
import { CentralStamp } from "../../components/settings/CentralStamp";
import { CheckCard } from "../../components/settings/CheckCard";
import { OfflineNotice } from "../../components/settings/OfflineNotice";
import { ProfileGate } from "../../components/settings/ProfileGate";
import { SavingStatus } from "../../components/settings/SavingStatus";
import { Skeleton } from "../../components/Skeleton";
import { Text } from "../../components/Text";
import { EmptyState, InfoBox, Input } from "../../components/ui";
import { ApiError } from "../../lib/api";
import { createAutoSave, useAutoSave } from "../../lib/autoSave";
import { TECH_PROFILE_LIMITS } from "../../lib/constants";
import { hasCadastroE2 } from "../../lib/profile";
import { reloadAreaCatalog, useAreaCatalog, useTechProfileScreen, type CatalogError } from "../../lib/technicalProfile";
import { sameSet, searchCatalog, toggleId, TOOL_SEARCH_AFTER } from "../../lib/techProfileForm";
import type { UUID } from "../../lib/types";
import { useStyles, useTheme, type Palette } from "../../theme/theme";

const NO_AREAS: UUID[] = [];

const areasSaver = createAutoSave<UUID[]>({
  select: (profile) => profile.area_ids ?? NO_AREAS,
  equals: sameSet,
  body: (ids) => ({ area_ids: ids }),
  offlineHint: "Conecte o aparelho para mudar as áreas de atuação.",
  errorTitle: "Não foi possível salvar as áreas de atuação",
  // A central desativou uma área marcada agora: o servidor a ignorou. A lista é relida e ela some.
  onSaved: (sent, saved) => {
    if (sent.some((id) => !saved.includes(id))) void reloadAreaCatalog();
  },
  // "Área não encontrada. Atualize a lista" (e o limite): a lista é relida.
  onFailed: (error) => {
    if (error instanceof ApiError && error.status === 422) void reloadAreaCatalog();
  },
});

const LIMIT_TEXT = `Limite de ${TECH_PROFILE_LIMITS.areas} áreas de atuação. Desmarque uma para marcar outra.`;

export default function AreasScreen() {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { gate, stale, retry, refresh, refreshing } = useTechProfileScreen(hasCadastroE2);
  const catalog = useAreaCatalog();
  const saved = gate.status === "ready" ? (gate.profile.area_ids ?? NO_AREAS) : NO_AREAS;
  const { value, change, status } = useAutoSave(areasSaver, saved);
  const [query, setQuery] = useState("");
  const areas = useMemo(() => (catalog.data ? searchCatalog(catalog.data, "") : null), [catalog.data]);

  // Uma área gravada que a lista não tem (a central a criou e marcou depois da leitura): relê a lista uma vez.
  const missing = areas ? saved.filter((id) => !areas.some((area) => area.id === id)).join(",") : "";
  useEffect(() => {
    if (missing) void reloadAreaCatalog();
  }, [missing]);

  const header = <Stack.Screen options={{ headerRight: () => <SavingStatus status={status} /> }} />;

  if (gate.status === "unavailable") {
    return (
      <>
        {header}
        <CadastroUnavailable onRetry={retry} />
      </>
    );
  }
  if (gate.status !== "ready") {
    return (
      <>
        {header}
        <ProfileGate load={gate} onRetry={retry} />
      </>
    );
  }

  function pull() {
    refresh();
    void reloadAreaCatalog();
  }

  // A busca só vale com a caixa à vista (a lista relida pode ficar curta e a caixa sumir).
  const searchable = Boolean(areas && areas.length > TOOL_SEARCH_AFTER);
  const search = searchable ? query.trim() : "";
  const shown = areas ? searchCatalog(areas, search) : [];
  // No limite, só dá para desmarcar (o servidor recusa a 21ª).
  const full = value.length >= TECH_PROFILE_LIMITS.areas;

  let list: ReactNode;
  if (!areas) {
    list = catalog.error ? (
      <CatalogFailure error={catalog.error} onRetry={() => void reloadAreaCatalog()} />
    ) : (
      <View style={styles.list}>
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} height={56} radius={12} />
        ))}
      </View>
    );
  } else if (!areas.length) {
    list = <EmptyState icon="grid" title="Lista vazia" description="A central ainda não cadastrou as áreas de atuação." />;
  } else {
    list = (
      <>
        {searchable ? (
          <Input
            icon="search"
            value={query}
            onChangeText={setQuery}
            placeholder="Buscar área"
            accessibilityLabel="Buscar área"
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            right={
              query ? (
                <Pressable onPress={() => setQuery("")} hitSlop={12} accessibilityRole="button" accessibilityLabel="Limpar a busca">
                  <Text style={styles.clear}>Limpar</Text>
                </Pressable>
              ) : null
            }
          />
        ) : null}
        {full ? <InfoBox message={LIMIT_TEXT} /> : null}
        {shown.length ? (
          <View style={styles.list}>
            {shown.map((area) => {
              const checked = value.includes(area.id);
              return (
                <CheckCard
                  key={area.id}
                  label={area.name}
                  checked={checked}
                  disabled={full && !checked}
                  onPress={() => change((current) => toggleId(current, area.id))}
                />
              );
            })}
          </View>
        ) : (
          <Text style={styles.none}>{`Nenhuma área com “${search}”.`}</Text>
        )}
      </>
    );
  }

  return (
    <>
      {header}
      <ScrollView
        style={styles.screen}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={pull} colors={[c.primary]} tintColor={c.primary} />}
      >
        <OfflineNotice />
        {stale ? <InfoBox message="Não foi possível atualizar agora. Os dados podem estar desatualizados." /> : null}
        <CentralStamp stamp={gate.profile.tech_profile_updated.areas} />
        {list}
      </ScrollView>
    </>
  );
}

/** A lista não veio: sem internet, servidor sem a rota (404) ou erro. */
function CatalogFailure({ error, onRetry }: { error: CatalogError; onRetry: () => void }) {
  const action = { label: "Tentar de novo", onPress: onRetry };
  if (error.offline) {
    return <EmptyState icon="wifiOff" title="Sem internet" description="Conecte o aparelho para ver as áreas de atuação." action={action} />;
  }
  return (
    <EmptyState
      icon="alert"
      title="Não foi possível abrir as áreas de atuação"
      description={error.missing ? "O servidor ainda não tem as áreas de atuação. Tente de novo mais tarde." : error.message}
      action={action}
    />
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.canvas },
    content: { padding: 16, gap: 12 },
    list: { gap: 8 },
    clear: { fontSize: 14, fontWeight: "600", color: c.brandInk },
    none: { fontSize: 14, color: c.inkMuted, textAlign: "center", paddingVertical: 16 },
  });
