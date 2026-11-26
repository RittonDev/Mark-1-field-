// O carimbo da central nas telas do perfil profissional (Dias e horários, Transporte, Formação, Áreas de atuação,
// Aptidões e Ferramental), logo abaixo dos avisos do topo: "Atualizado pela central em 20/11/2026" quando quem mudou a
// parte por último foi a central (tech_profile_updated[parte].via "central"). Pelo app ou pela ficha da homologação,
// foi o próprio técnico: nada aparece.

import { StyleSheet } from "react-native";
import { centralStampText } from "../../lib/techProfileForm";
import type { TechProfileStamp } from "../../lib/types";
import { useStyles, type Palette } from "../../theme/theme";
import { Text } from "../Text";

/** `stamp`: o carimbo da parte (ausente com o servidor de antes da gestão, que não tem a parte "areas"). */
export function CentralStamp({ stamp }: { stamp: TechProfileStamp | null | undefined }) {
  const styles = useStyles(makeStyles);
  const text = centralStampText(stamp);
  return text ? <Text style={styles.text}>{text}</Text> : null;
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    text: { fontSize: 13, color: c.inkMuted },
  });
