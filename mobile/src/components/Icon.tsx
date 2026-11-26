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
  | "wallet"
  // Formas de recebimento: chave PIX e conta bancária.
  | "key"
  | "bank"
  // Perfil, Configurações, Faturamento e oferta.
  | "settings"
  | "history"
  | "chart"
  | "medal"
  | "sync"
  | "logout"
  | "car"
  | "target"
  | "graduation"
  | "theme"
  | "bell"
  | "trash"
  | "pencil"
  | "search"
  | "receipt"
  | "wrench"
  | "map"
  | "timer"
  | "pie"
  | "message"
  // Cadastro: Documentos, Currículo e Áreas de atuação.
  | "idCard"
  | "fileText"
  | "grid";

/** `color` só serve às partes cheias (a metade pintada do "pie"); o traço vem do Svg. */
function Shape({ name, color }: { name: IconName; color: string }) {
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
    case "key": // chave PIX
      return (
        <>
          <Circle cx={8} cy={15} r={4.5} />
          <Path d="M11.2 11.8 20 3M16.5 6.5l2.5 2.5M14 9l2 2" />
        </>
      );
    case "bank": // conta bancária
      return <Path d="M3.5 9.5 12 4.5l8.5 5zM5.5 10v7M10 10v7M14 10v7M18.5 10v7M3.5 19.5h17" />;
    case "settings": // ajustes: três controles deslizantes (não engrenagem)
      return (
        <>
          <Path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h10M18 17h2" />
          <Circle cx={15} cy={7} r={2} />
          <Circle cx={9} cy={12} r={2} />
          <Circle cx={16} cy={17} r={2} />
        </>
      );
    case "history": // relógio com a seta voltando
      return (
        <>
          <Path d="M4.5 12a7.5 7.5 0 1 0 7.5-7.5" />
          <Path d="M14.6 2.2 12 4.5l2.6 2.3" />
          <Path d="M12 8.5V12l2.5 1.5" />
        </>
      );
    case "chart": // três colunas na linha de base
      return (
        <>
          <Rect x={4.75} y={12.5} width={3} height={6} rx={0.8} />
          <Rect x={10.5} y={6.5} width={3} height={12} rx={0.8} />
          <Rect x={16.25} y={9.5} width={3} height={9} rx={0.8} />
          <Path d="M3.5 21h17" />
        </>
      );
    case "medal": // contorno da medalha do elo: hexágono com uma divisa
      return (
        <>
          <Path d="M12 3.5l7.4 4.25v8.5L12 20.5l-7.4-4.25v-8.5z" />
          <Path d="M8.8 13.6 12 10.6l3.2 3" />
        </>
      );
    case "sync": // dois arcos com as pontas em sentidos opostos
      return (
        <>
          <Path d="M19.05 9.43A7.5 7.5 0 0 0 4.95 9.43" />
          <Path d="M4.95 6.2v3.23h3.25" />
          <Path d="M4.95 14.57a7.5 7.5 0 0 0 14.1 0" />
          <Path d="M19.05 17.8v-3.23H15.8" />
        </>
      );
    case "logout": // porta e seta para fora
      return (
        <>
          <Path d="M9.5 20.5H6a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 6 3.5h3.5" />
          <Path d="M15.5 16.5 20 12l-4.5-4.5M20 12H9.5" />
        </>
      );
    case "car":
      return (
        <>
          <Path d="M4 15.5v-3l1.9-4.5A2 2 0 0 1 7.8 6.5h8.4a2 2 0 0 1 1.9 1.5l1.9 4.5v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
          <Path d="M4.5 12h15" />
          <Circle cx={7.5} cy={16.5} r={1.7} />
          <Circle cx={16.5} cy={16.5} r={1.7} />
        </>
      );
    case "target":
      return (
        <>
          <Circle cx={12} cy={12} r={8.5} />
          <Circle cx={12} cy={12} r={5} />
          <Circle cx={12} cy={12} r={1.5} />
        </>
      );
    case "graduation":
      return (
        <>
          <Path d="M2.5 9.5 12 5l9.5 4.5L12 14z" />
          <Path d="M6.5 11.6v4c0 1.4 2.5 2.9 5.5 2.9s5.5-1.5 5.5-2.9v-4" />
          <Path d="M21.5 9.5v5" />
        </>
      );
    case "theme": // círculo meio hachurado (claro/escuro)
      return (
        <>
          <Circle cx={12} cy={12} r={8.5} />
          <Path d="M12 3.5v17M12 7h4.5M12 10.5h6M12 14h6M12 17.5h4.5" />
        </>
      );
    case "bell":
      return (
        <>
          <Path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z" />
          <Path d="M10 20.5a2 2 0 0 0 4 0" />
        </>
      );
    case "trash":
      return <Path d="M4.5 7h15M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2M6.5 7l.9 12a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-12M10 11v5.5M14 11v5.5" />;
    case "pencil":
      return (
        <>
          <Path d="M4.5 19.5l.8-3.6L15.6 5.6a1.8 1.8 0 0 1 2.6 0l.2.2a1.8 1.8 0 0 1 0 2.6L8.1 18.7z" />
          <Path d="M13.8 7.4l2.8 2.8" />
        </>
      );
    case "search":
      return (
        <>
          <Circle cx={10.5} cy={10.5} r={6} />
          <Path d="M15 15l5 5" />
        </>
      );
    case "receipt": // aba Faturamento
      return <Path d="M6 3.5h12v17l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4zM9 8h6M9 11.5h6M9 15h3.5" />;
    case "wrench": // chave: cartão "Serviços" da oferta e Ferramental
      return <Path d="M10.6 11.3L4.4 17.5a1.6 1.6 0 0 0 2.3 2.3l6.1-6.2a4.6 4.6 0 0 0 6.5-5.4l-2.6 2.6-2.3-.5-.5-2.3 2.6-2.6a4.6 4.6 0 0 0-5.4 6.5z" />;
    case "map":
      return <Path d="M3.5 6.2l5.5-2.2 6 2.2 5.5-2.2v13.8l-5.5 2.2-6-2.2-5.5 2.2zM9 4v13.8M15 6.2V20" />;
    case "timer": // duração estimada (a ampulheta continua sendo o prazo de resposta)
      return (
        <>
          <Circle cx={12} cy={13.5} r={7} />
          <Path d="M12 10v3.5l2.2 1.4M9.5 3.5h5M12 3.5v3M18.2 6.8l1.3-1.3" />
        </>
      );
    case "pie": // "Pago em parte"
      return (
        <>
          <Circle cx={12} cy={12} r={8.5} />
          <Path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill={color} stroke="none" />
        </>
      );
    case "message": // link do WhatsApp na oferta
      return <Path d="M5 5h14a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 5 5z" />;
    case "idCard": // Documentos: cartão com a foto e duas linhas
      return (
        <>
          <Rect x={3} y={5} width={18} height={14} rx={2.5} />
          <Circle cx={8.5} cy={11} r={2} />
          <Path d="M5.8 16.2a3 3 0 0 1 5.4 0M14 10h4.5M14 13.5h3" />
        </>
      );
    case "fileText": // Currículo: folha com a ponta dobrada e linhas
      return (
        <>
          <Path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z" />
          <Path d="M14 3.5V8h4.5M8.5 12.5h7M8.5 16h5" />
        </>
      );
    case "grid": // Áreas de atuação: quatro quadrados
      return (
        <>
          <Rect x={4} y={4} width={7} height={7} rx={1.5} />
          <Rect x={13} y={4} width={7} height={7} rx={1.5} />
          <Rect x={4} y={13} width={7} height={7} rx={1.5} />
          <Rect x={13} y={13} width={7} height={7} rx={1.5} />
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
      <Shape name={name} color={color} />
    </Svg>
  );
}
