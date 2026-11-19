// Configurações › Foto do perfil: a foto que aparece no Perfil, em Hoje e para a central. Tirar, escolher da galeria ou
// remover (no lugar ficam as iniciais), um toque cada. O andamento (enviando ou removendo) é o mesmo da linha de
// Configurações (lib/avatarFlow.ts). Só online, como todo o cadastro.

import { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Avatar } from "../../components/Avatar";
import { OfflineNotice } from "../../components/settings/OfflineNotice";
import { ProfileGate } from "../../components/settings/ProfileGate";
import { Text } from "../../components/Text";
import { Button, InfoBox } from "../../components/ui";
import { changeAvatar, deleteAvatar, useAvatarRecovery, useAvatarTask } from "../../lib/avatarFlow";
import { useProfileLoad } from "../../lib/useProfileForm";
import { useStyles, type Palette } from "../../theme/theme";

type Source = "camera" | "library";

export default function ProfilePhotoScreen() {
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { profile, load, retry } = useProfileLoad();
  const task = useAvatarTask();
  // O botão tocado mostra o andamento do envio; os outros ficam desativados.
  const [tapped, setTapped] = useState<Source | null>(null);
  useAvatarRecovery();

  if (!profile) return <ProfileGate load={load.status === "error" ? load : { status: "loading" }} onRetry={retry} />;

  function pick(source: Source) {
    setTapped(source);
    void changeAvatar(source).finally(() => setTapped(null));
  }

  const busy = task !== null;
  const group = profile.team?.name;
  // A releitura falhou por erro do servidor (sem rede, o OfflineNotice já avisa).
  const stale = load.status === "error" && !load.offline;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
      <View style={styles.notices}>
        <OfflineNotice />
        {stale ? <InfoBox message="Não foi possível atualizar agora. Os dados podem estar desatualizados." /> : null}
      </View>
      <Avatar name={profile.name} uri={profile.avatar_url} size={120} />
      <View style={styles.identity}>
        <Text style={styles.name}>{profile.name}</Text>
        <Text style={styles.role}>{group ? `Técnico parceiro · ${group}` : "Técnico parceiro"}</Text>
      </View>
      {task ? (
        <Text style={styles.status} accessibilityLiveRegion="polite">
          {task === "upload" ? "Enviando foto…" : "Removendo foto…"}
        </Text>
      ) : null}
      <View style={styles.buttons}>
        <Button
          title="Tirar foto"
          variant="primary"
          icon="camera"
          onPress={() => pick("camera")}
          loading={task === "upload" && tapped === "camera"}
          disabled={busy}
        />
        <Button
          title="Escolher da galeria"
          onPress={() => pick("library")}
          loading={task === "upload" && tapped === "library"}
          disabled={busy}
        />
        {profile.avatar_url ? (
          <Button
            compact
            variant="danger"
            title="Remover foto"
            onPress={() => void deleteAvatar()}
            loading={task === "remove"}
            disabled={busy}
            style={styles.remove}
          />
        ) : null}
      </View>
    </ScrollView>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.canvas },
    content: { padding: 24, alignItems: "center", gap: 16 },
    notices: { alignSelf: "stretch", gap: 10 },
    identity: { alignItems: "center", gap: 4 },
    name: { fontSize: 18, fontWeight: "700", color: c.ink, textAlign: "center" },
    role: { fontSize: 13, color: c.inkMuted, textAlign: "center" },
    status: { fontSize: 13, fontWeight: "600", color: c.inkMuted },
    buttons: { alignSelf: "stretch", gap: 10 },
    remove: { alignSelf: "flex-start" },
  });
