import { Platform } from "react-native";
import Svg, { Circle, Path, Rect } from "react-native-svg";

// Ícone é decorativo: o leitor de tela lê o texto ao lado. Na web o react-native-svg repassa as
// props ao <svg> do DOM, que não conhece as de acessibilidade do Android/iOS: lá vai aria-hidden.
export const SVG_HIDDEN = Platform.OS === "web"
  ? ({ "aria-hidden": true } as const)
  : ({ accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" } as const);

// Ícones de traço simples (24×24, traço 1,8), desenhados para o app.
export type IconName =
  | "mail"
  | "lock"
  | "eye"
  | "eyeOff"
  | "pin"
  | "clock"
  | "calendar"
  | "today"
  | "check"
  | "checkCircle"
  | "chevronRight"
  | "chevronLeft"
  | "chevronDown"
  | "chevronUp"
  | "share"
  | "navigate"
  | "more"
  | "user"
  | "building"
  | "alert"
  | "wifiOff"
  | "phone"
  | "copy"
  | "package"
  | "camera"
  | "shield"
  | "repeat"
  | "hourglass"
  | "plus"
  | "minus"
  | "close"
  | "note"
  | "users"
  | "wallet";

function Shape({ name }: { name: IconName }) {
  switch (name) {
    case "mail":
      return (
        <>
          <Rect x={3} y={5} width={18} height={14} rx={2.5} />
          <Path d="M4 7.5l8 5.5 8-5.5" />
        </>
      );
    case "lock":
      return (
        <>
          <Rect x={5} y={10.5} width={14} height={10} rx={2.5} />
          <Path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
        </>
      );
    case "eye":
      return (
        <>
          <Path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
          <Circle cx={12} cy={12} r={3} />
        </>
      );
    case "eyeOff":
      return (
        <>
          <Path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
          <Circle cx={12} cy={12} r={3} />
          <Path d="M4 4l16 16" />
        </>
      );
    case "pin":
      return (
        <>
          <Path d="M12 21s-6.5-5.9-6.5-11a6.5 6.5 0 0 1 13 0c0 5.1-6.5 11-6.5 11z" />
          <Circle cx={12} cy={10} r={2.3} />
        </>
      );
    case "clock":
      return (
        <>
          <Circle cx={12} cy={12} r={8.5} />
          <Path d="M12 7.5V12l3 2" />
        </>
      );
    case "calendar":
      return (
        <>
          <Rect x={3.5} y={5} width={17} height={15.5} rx={2.5} />
          <Path d="M3.5 9.5h17M8 3v4M16 3v4" />
        </>
      );
    case "today":
      return (
        <>
          <Rect x={3.5} y={5} width={17} height={15.5} rx={2.5} />
          <Path d="M3.5 9.5h17M8 3v4M16 3v4" />
          <Rect x={7.5} y={12.5} width={4} height={4} rx={1} />
        </>
      );
    case "check":
      return <Path d="M5 12.5l4.5 4.5L19 7.5" />;
    case "checkCircle":
      return (
        <>
          <Circle cx={12} cy={12} r={8.5} />
          <Path d="M8.3 12.3l2.6 2.6 5-5.4" />
        </>
      );
    case "chevronRight":
      return <Path d="M9.5 6l6 6-6 6" />;
    case "chevronLeft":
      return <Path d="M14.5 6l-6 6 6 6" />;
    case "chevronDown":
      return <Path d="M6 9.5l6 6 6-6" />;
    case "chevronUp":
      return <Path d="M6 14.5l6-6 6 6" />;
    case "share":
      return (
        <>
          <Circle cx={18} cy={5.5} r={2.5} />
          <Circle cx={6} cy={12} r={2.5} />
          <Circle cx={18} cy={18.5} r={2.5} />
          <Path d="M8.2 10.8l7.6-4.1M8.2 13.2l7.6 4.1" />
        </>
      );
    case "navigate":
      return <Path d="M4 11l16-7-7 16-2-7-7-2z" />;
    case "more":
      return (
        <>
          <Circle cx={5.5} cy={12} r={1.2} />
          <Circle cx={12} cy={12} r={1.2} />
          <Circle cx={18.5} cy={12} r={1.2} />
        </>
      );
    case "user":
      return (
        <>
          <Circle cx={12} cy={8.5} r={3.8} />
          <Path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
        </>
      );
    case "building":
      return <Path d="M4.5 20.5V4.5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16M14.5 9.5h4a1 1 0 0 1 1 1v10M8 7.5h3M8 11h3M8 14.5h3M3 20.5h18" />;
    case "alert":
      return (
        <>
          <Path d="M10.3 4.4L2.9 17.5a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.4a2 2 0 0 0-3.4 0z" />
          <Path d="M12 9.5v4M12 17h.01" />
        </>
      );
    case "wifiOff":
      return <Path d="M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5-2.6M14 10.4A10 10 0 0 1 19 13M2 9.5a15 15 0 0 1 4.5-2.8M10.5 5.6A15 15 0 0 1 22 9.5M12 20h.01" />;
    case "phone":
      return (
        <Path d="M6.6 3.5h2.6l1.4 4-2 1.3a10.5 10.5 0 0 0 6.6 6.6l1.3-2 4 1.4v2.6a2 2 0 0 1-2.2 2A16 16 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2z" />
      );
    case "copy":
      return (
        <>
          <Rect x={8.5} y={8.5} width={12} height={12} rx={2.2} />
          <Path d="M15.5 8.5V5.7a2.2 2.2 0 0 0-2.2-2.2H5.7a2.2 2.2 0 0 0-2.2 2.2v7.6a2.2 2.2 0 0 0 2.2 2.2h2.8" />
        </>
      );
    case "package":
      return (
        <>
          <Path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
          <Path d="M4 7.5l8 4.5 8-4.5M12 12v9M8 5.3l8 4.5" />
        </>
      );
    case "camera":
      return (
        <>
          <Path d="M4.5 7.5h3l1.5-2.5h6l1.5 2.5h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z" />
          <Circle cx={12} cy={13} r={3.6} />
        </>
      );
    case "shield":
      return (
        <>
          <Path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6L12 3z" />
          <Path d="M8.8 12.2l2.2 2.2 4.2-4.6" />
        </>
      );
    case "repeat":
      return <Path d="M17 3.5l3 3-3 3M4 11.5v-1a4 4 0 0 1 4-4h12M7 20.5l-3-3 3-3M20 12.5v1a4 4 0 0 1-4 4H4" />;
    case "hourglass":
      return <Path d="M6.5 3.5h11M6.5 20.5h11M7.5 3.5v3.2a4.5 4.5 0 0 0 2 3.7L12 12l2.5-1.6a4.5 4.5 0 0 0 2-3.7V3.5M7.5 20.5v-3.2a4.5 4.5 0 0 1 2-3.7L12 12l2.5 1.6a4.5 4.5 0 0 1 2 3.7v3.2" />;
    case "plus":
      return <Path d="M12 5v14M5 12h14" />;
    case "minus":
      return <Path d="M5 12h14" />;
    case "close":
      return <Path d="M6 6l12 12M18 6L6 18" />;
    case "note":
      return (
        <>
          <Rect x={5} y={3.5} width={14} height={17} rx={2.2} />
          <Path d="M8.5 8h7M8.5 11.5h7M8.5 15h4.5" />
        </>
      );
    case "users":
      return (
        <>
          <Circle cx={9} cy={8.5} r={3.3} />
          <Path d="M2.8 19.5a6.2 6.2 0 0 1 12.4 0" />
          <Path d="M15.5 5.6a3.2 3.2 0 0 1 0 6M17.5 14.2a6.2 6.2 0 0 1 3.7 5.3" />
        </>
      );
    case "wallet":
      return (
        <>
          <Rect x={3} y={6.5} width={18} height={13.5} rx={2.5} />
          <Path d="M6 6.5l8.6-2.8a1.6 1.6 0 0 1 2.1 1.5v1.3" />
          <Path d="M21 11.5h-4a1.75 1.75 0 0 0 0 3.5h4" />
        </>
      );
  }
}

export function Icon({ name, size = 20, color, strokeWidth = 1.8 }: { name: IconName; size?: number; color: string; strokeWidth?: number }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...SVG_HIDDEN}
    >
      <Shape name={name} />
    </Svg>
  );
}
