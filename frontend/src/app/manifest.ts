import type { MetadataRoute } from "next";

/**
 * App instalável (Windows pelo Edge/Chrome, também Android): ícone na área de trabalho e no menu
 * Iniciar, janela própria. O cliente abre direto nas solicitações; a equipe, na fila dela.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Maxx Field",
    short_name: "Maxx Field",
    description: "Abra e acompanhe chamados de T.I. com a Maxx.",
    lang: "pt-BR",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f0f2f5",
    theme_color: "#f0f2f5",
    icons: [
      { src: "/brand/app-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/brand/app-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/brand/app-icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      {
        name: "Nova solicitação",
        short_name: "Nova",
        description: "Abrir um chamado para a Maxx",
        url: "/portal/nova",
        icons: [{ src: "/brand/app-icon-192.png", sizes: "192x192", type: "image/png" }],
      },
    ],
  };
}
