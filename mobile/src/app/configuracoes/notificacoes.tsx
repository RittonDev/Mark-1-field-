// Configurações › Notificações: neste celular, os lembretes das visitas, a permissão e o alarme exato (o mesmo cartão
// da Sincronização); e os avisos da central, o push neste aparelho. Funciona sem internet: nada aqui é do cadastro.

import { ScrollView, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NotificationsCard, PushRow } from "../../components/NotificationsCard";
import { Card, SectionTitle } from "../../components/ui";
import { useStyles, type Palette } from "../../theme/theme";

export default function NotificationsScreen() {
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  return (
    <ScrollView style={styles.screen} contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
      <NotificationsCard title="Neste celular" />
      <Card style={styles.card}>
        <SectionTitle accent>Avisos da central</SectionTitle>
        <PushRow />
      </Card>
    </ScrollView>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.canvas },
    content: { padding: 16, gap: 14 },
    card: { gap: 4 },
  });
