import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Imagem Docker enxuta: o build gera um servidor autocontido.
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
