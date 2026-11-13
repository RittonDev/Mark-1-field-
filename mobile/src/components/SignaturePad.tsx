import { forwardRef, useEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import { Keyboard, PanResponder, StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import Svg, { Path } from "react-native-svg";
import { useTheme } from "../theme/theme";
import { Text } from "./Text";

export type Point = { x: number; y: number };
export type Stroke = Point[];
export interface PadSize {
  width: number;
  height: number;
}

export const INK = "#111827";
export const STROKE_WIDTH = 2.6;

/** Pontos a menos de 1,5 px do anterior não mudam o traço (e pesam no desenho). */
const MIN_STEP = 1.5;
const round = (n: number) => Math.round(n * 10) / 10;

export function strokePath(stroke: Stroke): string {
  if (!stroke.length) return "";
  const [first, ...rest] = stroke;
  // Um toque sem arrastar vira um ponto visível.
  if (!rest.length) return `M ${first.x} ${first.y} l 0.1 0.1`;
  return `M ${first.x} ${first.y} ` + rest.map((p) => `L ${p.x} ${p.y}`).join(" ");
}

/**
 * Leva os traços de uma área de assinatura para outra de outro tamanho (tela cheia ↔ normal) sem
 * distorcer: escala pela menor proporção e centraliza.
 */
export function fitStrokes(strokes: Stroke[], from: PadSize, to: PadSize): Stroke[] {
  if (!strokes.length || from.width <= 0 || from.height <= 0 || to.width <= 0 || to.height <= 0) return strokes;
  const scale = Math.min(to.width / from.width, to.height / from.height);
  const dx = (to.width - from.width * scale) / 2;
  const dy = (to.height - from.height * scale) / 2;
  return strokes.map((stroke) => stroke.map((p) => ({ x: round(p.x * scale + dx), y: round(p.y * scale + dy) })));
}

/** Instância nativa da View da área de assinatura (alvo da captura em PNG). */
export type PadHandle = ComponentRef<typeof View>;

/**
 * Área de assinatura: o responsável no local assina com o dedo. Fundo sempre branco e tinta escura
 * (como papel), para a imagem enviada ficar legível em qualquer tema. Controlada: o pai guarda os
 * traços (desfazer e limpar são dele). O `ref` aponta para a View capturada como PNG.
 *
 * Desempenho: o traço em curso cresce num ref e redesenha no máximo uma vez por quadro; os traços
 * prontos viram um único caminho.
 */
export const SignaturePad = forwardRef<
  PadHandle,
  {
    strokes: Stroke[];
    onChange: (strokes: Stroke[]) => void;
    onSize?: (size: PadSize) => void;
    height?: number;
    style?: StyleProp<ViewStyle>;
  }
>(function SignaturePad({ strokes, onChange, onSize, height, style }, ref) {
  const c = useTheme();
  const latest = useRef({ strokes, onChange });
  const live = useRef<{ points: Stroke; path: string } | null>(null);
  const frame = useRef<number | null>(null);
  const [livePath, setLivePath] = useState("");

  useEffect(() => {
    latest.current = { strokes, onChange };
  });

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const [responder] = useState(() => {
    const flush = () => {
      frame.current = null;
      const current = live.current;
      setLivePath(current ? (current.points.length === 1 ? strokePath(current.points) : current.path) : "");
    };
    const schedule = () => {
      if (frame.current === null) frame.current = requestAnimationFrame(flush);
    };
    const finish = () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      const stroke = live.current?.points;
      live.current = null;
      setLivePath("");
      if (stroke) latest.current.onChange([...latest.current.strokes, stroke]);
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (event) => {
        // O teclado do nome não pode cobrir a área nem roubar o primeiro traço.
        Keyboard.dismiss();
        const x = round(event.nativeEvent.locationX);
        const y = round(event.nativeEvent.locationY);
        live.current = { points: [{ x, y }], path: `M ${x} ${y}` };
        schedule();
      },
      onPanResponderMove: (event) => {
        const current = live.current;
        if (!current) return;
        const x = round(event.nativeEvent.locationX);
        const y = round(event.nativeEvent.locationY);
        const last = current.points[current.points.length - 1];
        if ((x - last.x) ** 2 + (y - last.y) ** 2 < MIN_STEP ** 2) return;
        current.points.push({ x, y });
        current.path += ` L ${x} ${y}`;
        schedule();
      },
      onPanResponderRelease: finish,
      onPanResponderTerminate: finish,
    });
  });

  const donePath = useMemo(() => strokes.map(strokePath).join(" "), [strokes]);

  function onLayout(event: LayoutChangeEvent) {
    const { width, height: h } = event.nativeEvent.layout;
    onSize?.({ width, height: h });
  }

  return (
    <View
      ref={ref}
      collapsable={false}
      onLayout={onLayout}
      style={[styles.pad, { borderColor: c.lineStrong }, height !== undefined && { height }, style]}
      {...responder.panHandlers}
      accessible
      accessibilityLabel="Área para assinar com o dedo"
      accessibilityHint="Peça para o responsável assinar com o dedo"
    >
      {/* Os desenhos nunca recebem o toque: as coordenadas são sempre as da área. */}
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Svg width="100%" height="100%">
          {donePath ? (
            <Path d={donePath} stroke={INK} strokeWidth={STROKE_WIDTH} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          ) : null}
          {livePath ? (
            <Path d={livePath} stroke={INK} strokeWidth={STROKE_WIDTH} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          ) : null}
        </Svg>
      </View>
      <View pointerEvents="none" style={styles.baseline} />
      {strokes.length === 0 && !livePath ? (
        <Text pointerEvents="none" style={styles.placeholder}>
          Assine aqui
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  pad: { backgroundColor: "#FFFFFF", borderRadius: 14, borderWidth: 1, overflow: "hidden", minHeight: 160 },
  baseline: { position: "absolute", left: 24, right: 24, bottom: 44, height: 1, backgroundColor: "#CBD2DC" },
  placeholder: { position: "absolute", left: 24, bottom: 52, fontSize: 15, color: "#687080" },
});
