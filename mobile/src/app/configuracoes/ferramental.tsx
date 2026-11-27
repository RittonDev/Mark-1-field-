// Ferramental (Configurações › Perfil profissional): o técnico marca as ferramentas que leva, do catálogo que a central
// mantém (Configurações › Técnicos, na central). Salva ao tocar, sem botão: os toques de perto vão juntos num envio só
// (sem rede, avisa e não muda). Ferramenta desativada na central com a tela aberta: o servidor ignora a marcação e a
// lista é relida (ela some); ferramenta marcada pela central que a lista ainda não tem: a lista é relida. Com muitas
// ferramentas, aparece a busca. Ferramental mudado por último pela central: o carimbo "Atualizado pela central em …" no
// topo.

import { Stack } from "expo-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
import { reloadToolCatalog, UNAVAILABLE, useTechProfileScreen, useToolCatalog, type CatalogError } from "../../lib/technicalProfile";
import { filterTools, sameSet, sortTools, toggleId, TOOL_SEARCH_AFTER } from "../../lib/techProfileForm";
import type { UUID } from "../../lib/types";
import { useStyles, useTheme, type Palette } from "../../theme/theme";

const toolsSaver = createAutoSave<UUID[]>({
  select: (profile) => profile.tool_ids,
  equals: sameSet,
  body: (ids) => ({ tool_ids: ids }),
  offlineHint: "Conecte o aparelho para mudar o ferramental.",
  errorTitle: "Não foi possível salvar o ferramental",
  // A central desativou uma ferramenta marcada agora: o servidor a ignorou. A lista é relida e ela some.
  onSaved: (sent, saved) => {
    if (sent.some((id) => !saved.includes(id))) void reloadToolCatalog();
  },
  // "Ferramenta não encontrada. Atualize a lista.": a lista é relida.
  onFailed: (error) => {
    if (error instanceof ApiError && error.status === 422) void reloadToolCatalog();
  },
});

const NO_TOOLS: UUID[] = [];

export default function ToolsScreen() {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { gate, stale, retry, refresh, refreshing } = useTechProfileScreen();
  const catalog = useToolCatalog();
  const saved = gate.status === "ready" ? gate.profile.tool_ids : NO_TOOLS;
  const { value, change, status } = useAutoSave(toolsSaver, saved);
  const [query, setQuery] = useState("");
  const tools = useMemo(() => (catalog.data ? sortTools(catalog.data) : null), [catalog.data]);

  // Uma ferramenta gravada que a lista não tem (a central a criou e marcou depois da leitura): relê a lista uma vez.
  const missing = tools ? saved.filter((id) => !tools.some((tool) => tool.id === id)).join(",") : "";
  useEffect(() => {
    if (missing) void reloadToolCatalog();
  }, [missing]);

  const header =<Stack.Screen options={{ headerRight: () => <SavingStatus status={status} /> }} />;

  if (gate.status === "unavailable") {
    return (
      <>
        {header}
        <View style={styles.center}>
          <EmptyState icon="alert" title={UNAVAILABLE.title} description={UNAVAILABLE.description} action={{ label: "Tentar de novo", onPress: retry }} />
        </View>
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
    void reloadToolCatalog();
  }

  // A busca só vale com a caixa à vista (a lista relida pode ficar curta e a caixa sumir).
  const searchable = Boolean(tools && tools.length > TOOL_SEARCH_AFTER);
  const search = searchable ? query.trim() : "";
  const shown = tools ? filterTools(tools, search) : [];

  let list: ReactNode;
  if (!tools) {
    list = catalog.error ? (
      <CatalogFailure error={catalog.error} onRetry={() => void reloadToolCatalog()} />
    ) : (
      <View style={styles.list}>
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} height={56} radius={12} />
        ))}
      </View>
    );
  } else if (!tools.length) {
    list = <EmptyState icon="wrench" title="Lista vazia" description="A central ainda não cadastrou o ferramental." />;
  } else {
    list = (
      <>
        {searchable ? (
          <Input
            icon="search"
            value={query}
            onChangeText={setQuery}
            placeholder="Buscar ferramenta"
            accessibilityLabel="Buscar ferramenta"
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
        {shown.length ? (
          <View style={styles.list}>
            {shown.map((tool) => (
              <CheckCard
                key={tool.id}
                label={tool.name}
                checked={value.includes(tool.id)}
                onPress={() => change((current) => toggleId(current, tool.id))}
              />
            ))}
          </View>
        ) : (
          <Text style={styles.none}>{`Nenhuma ferramenta com “${search}”.`}</Text>
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
        <CentralStamp stamp={gate.profile.tech_profile_updated.tools} />
        {list}
      </ScrollView>
    </>
  );
}

/** A lista não veio: sem internet, servidor antigo (sem a rota) ou erro. */
function CatalogFailure({ error, onRetry }: { error: CatalogError; onRetry: () => void }) {
  const action = { label: "Tentar de novo", onPress: onRetry };
  if (error.offline) {
    return <EmptyState icon="wifiOff" title="Sem internet" description="Conecte o aparelho para ver a lista de ferramentas." action={action} />;
  }
  return (
    <EmptyState
      icon="alert"
      title="Não foi possível abrir a lista de ferramentas"
      description={error.missing ? "O servidor ainda não tem o ferramental. Tente de novo mais tarde." : error.message}
      action={action}
    />
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.canvas },
    content: { padding: 16, gap: 12 },
    center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: c.canvas },
    list: { gap: 8 },
    clear: { fontSize: 14, fontWeight: "600", color: c.brandInk },
    none: { fontSize: 14, color: c.inkMuted, textAlign: "center", paddingVertical: 16 },
  });
