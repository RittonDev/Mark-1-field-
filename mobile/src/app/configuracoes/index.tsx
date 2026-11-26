// Configurações (Perfil › Configurações): o cadastro do técnico nos 3 grupos de seções que a central também usa
// (TECH_SECTION_GROUPS, com os mesmos nomes; "Credenciais" aqui é "Senha"; só as seções da entrega no ar,
// CADASTRO_DELIVERY) e o grupo App (aparência, notificações e sincronização). Cada linha tem o resumo à direita. Abre
// sempre, até sem internet: cada tela cuida do próprio estado. Com o servidor de antes do cadastro V2 (hasCadastroV2),
// as linhas do cadastro, menos Foto, Senha e o perfil profissional, dizem "Indisponível". O cadastro fica só na memória
// (lib/profile.ts).

import { router } from "expo-router";
import { useState, type ReactNode } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ActionSheet, type SheetAction } from "../../components/ActionSheet";
import { Avatar } from "../../components/Avatar";
import type { IconName } from "../../components/Icon";
import { MenuGroup, MenuRow } from "../../components/MenuRow";
import { useNotificationsSummary } from "../../components/NotificationsCard";
import { Skeleton } from "../../components/Skeleton";
import { Text } from "../../components/Text";
import { Button, InfoBox } from "../../components/ui";
import { useAvatarRecovery, useAvatarTask } from "../../lib/avatarFlow";
import { CADASTRO_DELIVERY, TECH_SECTION_GROUPS, transportText } from "../../lib/constants";
import { haptic } from "../../lib/haptics";
import { openSync } from "../../lib/navigation";
import { payoutRowSummary } from "../../lib/payoutForm";
import { hasCadastroV2, hasTechnicalProfile } from "../../lib/profile";
import { addressSummary, bioSummary, companySummary, contactRowSummary, countLabel, todayIso } from "../../lib/profileForm";
import { useSession } from "../../lib/session";
import { useSyncStatus } from "../../lib/sync";
import { useSyncSummary } from "../../lib/syncSummary";
import type { MyProfile, TechSectionKey } from "../../lib/types";
import { scheduleSummary } from "../../lib/unavailability";
import { useProfileLoad } from "../../lib/useProfileForm";
import { setThemePreference, useStyles, useTheme, useThemePreference, type Palette, type ThemePreference } from "../../theme/theme";

const THEME_OPTIONS: { value: ThemePreference; label: string; description?: string }[] = [
  { value: "system", label: "Sistema", description: "Acompanha o modo do celular" },
  { value: "light", label: "Claro" },
  { value: "dark", label: "Escuro" },
];

const THEME_LABEL: Record<ThemePreference, string> = { system: "Sistema", light: "Claro", dark: "Escuro" };

/** O que vai à direita de uma linha (e, quando o resumo não se lê bem em voz alta, o que o leitor de tela fala). */
interface RowSummary {
  value?: string | null;
  valueTone?: "muted" | "warning";
  trailing?: ReactNode;
  accessibilityLabel?: string;
}

/** Linha cuja tela o servidor ainda não tem (cadastro V2 ou perfil técnico): a tela de cada uma explica. */
const NOT_AVAILABLE: RowSummary = { value: "Indisponível" };

/** O ícone e a tela de cada seção (sem entrada: a seção ainda não tem tela no app, e a linha não aparece). */
const SECTION_ROW: Partial<Record<TechSectionKey, { icon: IconName; href: string }>> = {
  foto: { icon: "camera", href: "/configuracoes/foto" },
  "dados-pessoais": { icon: "user", href: "/configuracoes/dados-pessoais" },
  endereco: { icon: "pin", href: "/configuracoes/endereco" },
  contato: { icon: "phone", href: "/configuracoes/contato" },
  credenciais: { icon: "lock", href: "/trocar-senha" },
  "mini-biografia": { icon: "note", href: "/configuracoes/biografia" },
  "dados-empresariais": { icon: "building", href: "/configuracoes/empresa" },
  recebimento: { icon: "wallet", href: "/configuracoes/recebimento" },
  "dias-e-horarios": { icon: "calendar", href: "/configuracoes/disponibilidade" },
  transporte: { icon: "car", href: "/configuracoes/transporte" },
  formacao: { icon: "graduation", href: "/configuracoes/formacao" },
  aptidoes: { icon: "target", href: "/configuracoes/aptidoes" },
  ferramental: { icon: "wrench", href: "/configuracoes/ferramental" },
};

/** Os grupos com as seções que o app mostra nesta entrega. */
const GROUPS = TECH_SECTION_GROUPS.map((group) => ({
  ...group,
  sections: group.sections.filter((section) => section.delivery <= CADASTRO_DELIVERY && SECTION_ROW[section.key]),
}));

/** Itens de uma lista do perfil técnico. */
const size = (list: readonly unknown[] | null | undefined) => (Array.isArray(list) ? list.length : 0);

/** Quanto da biografia o leitor de tela fala na linha. */
const SPOKEN_MAX = 60;

function contactRow(p: MyProfile): RowSummary {
  const { value, tone } = contactRowSummary(p);
  return { value, valueTone: tone };
}

/** A preferencial mascarada; o leitor de tela fala só o tipo (como a linha do Faturamento). */
function payoutRow(p: MyProfile, label: string): RowSummary {
  const { value, tone, spoken } = payoutRowSummary(p);
  return { value, valueTone: tone, accessibilityLabel: spoken.startsWith(label) ? spoken : `${label}, ${spoken}` };
}

export default function SettingsScreen() {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { user } = useSession();
  const { profile, load, retry, refresh, refreshing } = useProfileLoad();
  const theme = useThemePreference();
  const [themeSheet, setThemeSheet] = useState(false);
  // Puxar para atualizar relê também o resumo das notificações (a linha monta de novo).
  const [round, setRound] = useState(0);
  useAvatarRecovery();

  const loading = !profile && load.status === "loading";
  const placeholder: RowSummary = loading ? { trailing: <Skeleton width={64} height={12} /> } : {};
  /** Resumo do cadastro V2: lendo, o esqueleto; sem cadastro (sem rede ou erro), nada; API de antes, "Indisponível". */
  const fromCadastro = (summary: (p: MyProfile) => RowSummary): RowSummary =>
    profile ? (hasCadastroV2(profile) ? summary(profile) : NOT_AVAILABLE) : placeholder;
  /** Servidor ainda sem o perfil técnico (API antiga): "Indisponível"; a tela de cada linha explica. */
  const fromTechnical = (summary: (p: MyProfile) => RowSummary): RowSummary =>
    hasTechnicalProfile(profile) ? summary(profile) : profile ? NOT_AVAILABLE : placeholder;

  function summaryOf(key: TechSectionKey, label: string): RowSummary {
    switch (key) {
      case "dados-pessoais":
        // Sem o cadastro na memória, o nome da sessão (como no topo de Hoje).
        return profile ? fromCadastro((p) => ({ value: p.name })) : { value: user?.name ?? null };
      case "endereco":
        return fromCadastro((p) => ({ value: addressSummary(p.home_city, p.home_state) }));
      case "contato":
        return fromCadastro(contactRow);
      case "mini-biografia":
        return fromCadastro((p) => {
          const value = bioSummary(p.bio);
          // O leitor de tela fala o começo do texto, não a biografia inteira a cada passada pela linha.
          return { value, accessibilityLabel: `${label}, ${value.length > SPOKEN_MAX ? `${value.slice(0, SPOKEN_MAX).trimEnd()}…` : value}` };
        });
      case "dados-empresariais":
        return fromCadastro((p) => ({ value: companySummary(p) }));
      case "recebimento":
        return fromCadastro((p) => payoutRow(p, label));
      case "dias-e-horarios":
        // Os turnos valem também com a API de antes; os períodos de indisponibilidade, só com o cadastro V2.
        return fromTechnical((p) => ({
          value: scheduleSummary(p.availability, hasCadastroV2(p) ? p.unavailability : undefined, todayIso()),
        }));
      case "transporte":
        return fromTechnical((p) => ({ value: transportText(p.transport) ?? "Não informado" }));
      case "formacao":
        return fromTechnical((p) => ({ value: countLabel(size(p.education), "formação", "formações") }));
      case "aptidoes":
        return fromTechnical((p) => ({ value: countLabel(size(p.skills), "aptidão", "aptidões") }));
      case "ferramental":
        return fromTechnical((p) => ({ value: countLabel(size(p.tool_ids), "ferramenta", "ferramentas") }));
      default:
        // Senha (e o que ainda não tem resumo): só o rótulo.
        return {};
    }
  }

  function pull() {
    refresh();
    setRound((n) => n + 1);
  }

  const themeActions: SheetAction[] = THEME_OPTIONS.map((option) => ({
    key: option.value,
    label: option.label,
    description: option.description,
    selected: theme === option.value,
    onPress: () => {
      haptic.select();
      void setThemePreference(option.value);
    },
  }));

  return (
    <>
      <ScrollView
        style={styles.screen}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={pull} colors={[c.primary]} tintColor={c.primary} />}
      >
        <SettingsNotice failed={!profile && load.status === "error"} onRetry={retry} />

        {GROUPS.map((group) => (
          <MenuGroup key={group.key} title={group.label}>
            {group.sections.map((section) => {
              const row = SECTION_ROW[section.key];
              if (!row) return null;
              const label = section.app ?? section.label;
              if (section.key === "foto") {
                return <PhotoRow key={section.key} label={label} profile={profile} loading={loading} fallbackName={user?.name ?? null} />;
              }
              return (
                <MenuRow
                  key={section.key}
                  icon={row.icon}
                  label={label}
                  {...summaryOf(section.key, label)}
                  onPress={() => router.push(row.href)}
                />
              );
            })}
          </MenuGroup>
        ))}

        <MenuGroup title="App">
          <MenuRow icon="theme" label="Aparência" value={THEME_LABEL[theme]} onPress={() => setThemeSheet(true)} />
          <NotificationsRow key={`notificacoes-${round}`} />
          <SyncRow />
        </MenuGroup>
      </ScrollView>

      <ActionSheet visible={themeSheet} title="Aparência" actions={themeActions} onClose={() => setThemeSheet(false)} />
    </>
  );
}

/** No máximo um aviso: sem rede; ou, com rede, o cadastro que não veio. */
function SettingsNotice({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  const styles = useStyles(makeStyles);
  const { network } = useSyncStatus();
  if (network === "offline") return <InfoBox icon="wifiOff" message="Sem internet: para mudar o cadastro, conecte o aparelho." />;
  if (!failed) return null;
  return (
    <View style={styles.notice}>
      <InfoBox icon="alert" message="Não foi possível carregar seu cadastro." />
      <Button compact variant="ghost" title="Tentar de novo" onPress={onRetry} style={styles.retry} />
    </View>
  );
}

/**
 * A foto à direita (as iniciais sem foto; sem o cadastro na memória, as do nome da sessão, como no topo de Hoje);
 * enviando ou removendo, o andamento, igual ao da tela Foto do perfil.
 */
function PhotoRow({
  label,
  profile,
  loading,
  fallbackName,
}: {
  label: string;
  profile: MyProfile | null;
  loading: boolean;
  fallbackName: string | null;
}) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const task = useAvatarTask();
  const busy = task === "upload" ? "Enviando foto" : task === "remove" ? "Removendo foto" : null;
  const trailing = busy ? (
    <View style={styles.photoBusy}>
      <ActivityIndicator size="small" color={c.inkMuted} />
      <Text style={styles.photoBusyText} numberOfLines={1} maxFontSizeMultiplier={1.3}>
        {`${busy}…`}
      </Text>
    </View>
  ) : profile ? (
    <Avatar name={profile.name} uri={profile.avatar_url} size={28} />
  ) : loading ? (
    <Skeleton width={28} height={28} radius={14} />
  ) : (
    <Avatar name={fallbackName} size={28} />
  );
  return (
    <MenuRow
      icon="camera"
      label={label}
      trailing={trailing}
      accessibilityLabel={busy ? `${label}, ${busy.toLowerCase()}` : label}
      onPress={() => router.push("/configuracoes/foto")}
    />
  );
}

/** "Ligadas", "Desligadas", "Bloqueadas" (âmbar) ou "Indisponíveis"; lendo, nada. */
function NotificationsRow() {
  const summary = useNotificationsSummary();
  return (
    <MenuRow
      icon="bell"
      label="Notificações"
      value={summary.value}
      valueTone={summary.tone}
      onPress={() => router.push("/configuracoes/notificacoes")}
    />
  );
}

/** Ações recusadas (vermelho), a pílula dos itens para enviar, "Sem internet" ou "Tudo enviado". */
function SyncRow() {
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
    screen: { flex: 1, backgroundColor: c.canvas },
    content: { padding: 16, gap: 18 },
    notice: { gap: 6 },
    retry: { alignSelf: "flex-start" },
    photoBusy: { flexDirection: "row", alignItems: "center", gap: 6 },
    photoBusyText: { fontSize: 14, fontWeight: "500", color: c.inkMuted },
  });
