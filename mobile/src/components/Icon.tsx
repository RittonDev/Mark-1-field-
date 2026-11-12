import Svg, { Circle, Path, Rect } from "react-native-svg";

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
  | "navigate"
  | "more"
  | "user"
  | "building"
  | "alert"
  | "wifiOff";

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
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Shape name={name} />
    </Svg>
  );
}
