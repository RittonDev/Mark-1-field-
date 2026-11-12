// Endereços do atendimento (sem dependências nativas, para poder ser testado fora do app).
//
// O local é uma filial cadastrada (com coordenadas, código e CNPJ). A OS pode ter um
// `service_address` próprio quando o atendimento é em outro endereço; nesse caso ele manda.

import type { LocationRef } from "./types";

/** Endereço cadastrado da filial: "Rua X, 100, Cidade, UF". */
export function addressOf(location: LocationRef | null): string | null {
  if (!location) return null;
  const parts = [location.address_line, location.city, location.state].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/** Endereço do atendimento completado com cidade/UF da filial quando ainda não os menciona. */
export function serviceAddressQuery(serviceAddress: string, location: LocationRef | null): string {
  const text = serviceAddress.trim();
  const lower = text.toLowerCase();
  const extra = [location?.city, location?.state].filter(
    (part): part is string => Boolean(part) && !lower.includes(String(part).toLowerCase()),
  );
  return [text, ...extra].join(", ");
}

export type MapTarget =
  | { kind: "coords"; latitude: number; longitude: number; label: string }
  | { kind: "address"; query: string; label: string };

/**
 * Para onde o botão de mapa/rota aponta:
 * 1. `service_address` da OS (com cidade/UF da filial), quando preenchido;
 * 2. coordenadas da filial;
 * 3. endereço cadastrado da filial (ou só o nome).
 */
export function mapTarget(location: LocationRef | null, serviceAddress: string | null | undefined): MapTarget | null {
  const label = location ? [location.code, location.name].filter(Boolean).join(" ") : "Atendimento";
  if (serviceAddress?.trim()) {
    return { kind: "address", query: serviceAddressQuery(serviceAddress, location), label };
  }
  if (!location) return null;
  if (location.latitude !== null && location.longitude !== null) {
    return { kind: "coords", latitude: location.latitude, longitude: location.longitude, label };
  }
  return { kind: "address", query: addressOf(location) ?? location.name, label };
}
