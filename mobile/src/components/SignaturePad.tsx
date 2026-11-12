import { forwardRef, useEffect, useRef, useState, type ComponentRef } from "react";
import { PanResponder, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { Text } from "./Text";
import Svg, { Path } from "react-native-svg";
import { useTheme } from "../theme/theme";

export type Point = { x: number; y: number };
export type Stroke = Point[];

export const INK = "#111827";
export const STROKE_WIDTH = 2.6;

export function strokePath(stroke: Stroke): string {
  if (!stroke.length) return "";
  const [first, ...rest] = stroke;
  // Um toque sem arrastar vira um ponto visível.
  if (!rest.length) return `M ${first.x} ${first.y} l 0.1 0.1`;
  return `M ${first.x} ${first.y} ` + rest.map((p) => `L ${p.x} ${p.y}`).join(" ");
}

/** Instância nativa da View da área de assinatura (alvo da captura em PNG). */
export type PadHandle = ComponentRef<typeof View>;

/**
 * Área de assinatura: o responsável no local assina com o dedo. Fundo sempre branco e tinta
 * escura (como papel), para a imagem enviada ficar legível em qualquer tema.
 * O `ref` aponta para a View capturada como PNG; para limpar, o pai troca a `key`.
 */
export const SignaturePad = forwardRef<
  PadHandle,
  { onChange: (strokes: Stroke[]) => void; onSize?: (size: { width: number; height: number }) => void; height?: number }
>(function SignaturePad({ onChange, onSize, height = 220 }, ref) {
  const c = useTheme();
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [current, setCurrent] = useState<Stroke | null>(null);
  const live = useRef<Stroke | null>(null);

  useEffect(() => {
    onChange(strokes);
  }, [strokes, onChange]);

  const [responder] = useState(() => {
    const finish = () => {
      const stroke = live.current;
      live.current = null;
      setCurrent(null);
      if (stroke) setStrokes((prev) => [...prev, stroke]);
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (event) => {
        const { locationX, locationY } = event.nativeEvent;
        live.current = [{ x: locationX, y: locationY }];
        setCurrent(live.current);
      },
      onPanResponderMove: (event) => {
        if (!live.current) return;
        const { locationX, locationY } = event.nativeEvent;
        live.current = [...live.current, { x: locationX, y: locationY }];
        setCurrent(live.current);
      },
      onPanResponderRelease: finish,
      onPanResponderTerminate: finish,
    });
  });

  function onLayout(event: LayoutChangeEvent) {
    const { width, height: h } = event.nativeEvent.layout;
    onSize?.({ width, height: h });
  }

  const visible = current ? [...strokes, current] : strokes;

  return (
    <View
      ref={ref}
      collapsable={false}
      onLayout={onLayout}
      style={[styles.pad, { height, borderColor: c.lineStrong }]}
      {...responder.panHandlers}
      accessibilityLabel="Área para assinar com o dedo"
    >
      <Svg width="100%" height="100%">
        {visible.map((stroke, i) => (
          <Path
            key={i}
            d={strokePath(stroke)}
            stroke={INK}
            strokeWidth={STROKE_WIDTH}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        ))}
      </Svg>
      <View pointerEvents="none" style={styles.baseline} />
      {visible.length === 0 ? (
        <Text pointerEvents="none" style={styles.placeholder}>
          Assine aqui
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  pad: { backgroundColor: "#FFFFFF", borderRadius: 14, borderWidth: 1, overflow: "hidden" },
  baseline: { position: "absolute", left: 24, right: 24, bottom: 44, height: 1, backgroundColor: "#CBD2DC" },
  placeholder: { position: "absolute", left: 24, bottom: 52, fontSize: 14, color: "#98A2B3" },
});
