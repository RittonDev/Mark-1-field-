// Configurações (Perfil › Configurações): o cadastro do técnico em 4 grupos, cada linha com o resumo à direita. Perfil
// (foto, dados pessoais, contato, endereço e senha), Pagamento (chave PIX), Atendimento (o perfil técnico:
// disponibilidade, transporte, aptidões, formação e ferramental) e App (aparência, notificações e sincronização). Abre
// sempre, até sem internet: cada tela cuida do próprio estado. O cadastro fica só na memória (lib/profile.ts).

import { router } from "expo-router";
import { useState, type ReactNode } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ActionSheet, type SheetAction } from "../../components/ActionSheet";
import { Avatar } from "../../components/Avatar";
import { MenuGroup, MenuRow } from "../../components/MenuRow";
import { useNotificationsSummary } from "../../components/NotificationsCard";
import { Skeleton } from "../../components/Skeleton";
import { Text } from "../../components/Text";
import { Button, InfoBox } from "../../components/ui";
import { useAvatarRecovery, useAvatarTask } from "../../lib/avatarFlow";
import { availabilitySummary, PIX_KEY_TYPE, transportText } from "../../lib/constants";
import { haptic } from "../../lib/haptics";
import { openSync } from "../../lib/navigation";
import { hasTechnicalProfile } from "../../lib/profile";
import { addressSummary, contactSummary, countLabel, NO_PHONE, NO_PIX, pixSummary } from "../../lib/profileForm";
import { useSession } from "../../lib/session";
import { useSyncStatus } from "../../lib/sync";
import { useSyncSummary } from "../../lib/syncSummary";
import type { MyProfile } from "../../lib/types";
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

/** Linhas de Atendimento quando o servidor ainda não manda o perfil técnico (a tela de cada uma explica). */
const NO_TECHNICAL_PROFILE: RowSummary = { value: "Indisponível" };

/** Itens de uma lista do perfil técnico. */
const size = (list: readonly unknown[] | null | undefined) => (Array.isArray(list) ? list.length : 0);

function phoneRow(p: MyProfile): RowSummary {
  const phone = contactSummary(p.phone);
  return phone ? { value: phone } : { value: NO_PHONE, valueTone: "warning" };
}

/** A chave aparece mascarada; o leitor de tela fala só o tipo (como a linha do PIX no Faturamento). */
function pixRow(p: MyProfile): RowSummary {
  if (!p.pix) return { value: NO_PIX, valueTone: "warning" };
  return { value: pixSummary(p.pix), accessibilityLabel: `Chave PIX, ${PIX_KEY_TYPE[p.pix.key_type]}` };
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
  /** Resumo que depende do cadastro: lendo, o esqueleto; sem cadastro (sem rede ou erro), nada. A linha abre sempre. */
  const fromProfile = (summary: (p: MyProfile) => RowSummary): RowSummary => (profile ? summary(profile) : placeholder);
  /** Servidor ainda sem o perfil técnico (API antiga): "Indisponível"; a tela de cada linha explica. */
  const fromTechnical = (summary: (p: MyProfile) => RowSummary): RowSummary =>
    hasTechnicalProfile(profile) ? summary(profile) : profile ? NO_TECHNICAL_PROFILE : placeholder;

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

        <MenuGroup title="Perfil">
          <PhotoRow profile={profile} loading={loading} fallbackName={user?.name ?? null} />
          <MenuRow
            icon="user"
            label="Dados pessoais"
            value={profile?.name ?? user?.name ?? null}
            onPress={() => router.push("/configuracoes/dados-pessoais")}
          />
          <MenuRow icon="phone" label="Contato" {...fromProfile(phoneRow)} onPress={() => router.push("/configuracoes/contato")} />
          <MenuRow
            icon="pin"
            label="Endereço"
            {...fromProfile((p) => ({ value: addressSummary(p.home_city, p.home_state) }))}
            onPress={() => router.push("/configuracoes/endereco")}
          />
          <MenuRow icon="lock" label="Senha" onPress={() => router.push("/trocar-senha")} />
        </MenuGroup>

        <MenuGroup title="Pagamento">
          <MenuRow icon="wallet" label="Chave PIX" {...fromProfile(pixRow)} onPress={() => router.push("/configuracoes/pix")} />
        </MenuGroup>

        <MenuGroup title="Atendimento">
          <MenuRow
            icon="calendar"
            label="Disponibilidade"
            {...fromTechnical((p) => ({ value: availabilitySummary(p.availability) }))}
            onPress={() => router.push("/configuracoes/disponibilidade")}
          />
          <MenuRow
            icon="car"
            label="Transporte"
            {...fromTechnical((p) => ({ value: transportText(p.transport) ?? "Não informado" }))}
            onPress={() => router.push("/configuracoes/transporte")}
          />
          <MenuRow
            icon="target"
            label="Aptidões"
            {...fromTechnical((p) => ({ value: countLabel(size(p.skills), "aptidão", "aptidões") }))}
            onPress={() => router.push("/configuracoes/aptidoes")}
          />
          <MenuRow
            icon="graduation"
            label="Formação"
            {...fromTechnical((p) => ({ value: countLabel(size(p.education), "formação", "formações") }))}
            onPress={() => router.push("/configuracoes/formacao")}
          />
          <MenuRow
            icon="wrench"
            label="Ferramental"
            {...fromTechnical((p) => ({ value: countLabel(size(p.tool_ids), "ferramenta", "ferramentas") }))}
            onPress={() => router.push("/configuracoes/ferramental")}
          />
        </MenuGroup>

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
function PhotoRow({ profile, loading, fallbackName }: { profile: MyProfile | null; loading: boolean; fallbackName: string | null }) {
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
      label="Foto do perfil"
      trailing={trailing}
      accessibilityLabel={busy ? `Foto do perfil, ${busy.toLowerCase()}` : "Foto do perfil"}
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
