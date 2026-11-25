"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { NoAccess } from "@/components/NoAccess";
import { isUuid } from "@/components/operacao/hooks";
import { FichaHeader } from "@/components/technicians/ficha/FichaHeader";
import { fichaLabel, fichaMenu, FichaNav } from "@/components/technicians/ficha/FichaNav";
import { FICHA_HEADING_ID, SectionCard } from "@/components/technicians/ficha/SectionCard";
import { AddressSection } from "@/components/technicians/ficha/sections/AddressSection";
import { BioSection } from "@/components/technicians/ficha/sections/BioSection";
import { CompanySection } from "@/components/technicians/ficha/sections/CompanySection";
import { ContactSection } from "@/components/technicians/ficha/sections/ContactSection";
import { CredentialsSection } from "@/components/technicians/ficha/sections/CredentialsSection";
import { EducationSection } from "@/components/technicians/ficha/sections/EducationSection";
import { EloSection } from "@/components/technicians/ficha/sections/EloSection";
import { FavoritesSection } from "@/components/technicians/ficha/sections/FavoritesSection";
import { HistorySection } from "@/components/technicians/ficha/sections/HistorySection";
import { PayoutMethodsSection } from "@/components/technicians/ficha/sections/PayoutMethodsSection";
import { PersonalDataSection } from "@/components/technicians/ficha/sections/PersonalDataSection";
import { PhotoSection } from "@/components/technicians/ficha/sections/PhotoSection";
import { ScheduleSection } from "@/components/technicians/ficha/sections/ScheduleSection";
import { SkillsSection } from "@/components/technicians/ficha/sections/SkillsSection";
import { StatusSection } from "@/components/technicians/ficha/sections/StatusSection";
import { TeamSection } from "@/components/technicians/ficha/sections/TeamSection";
import { ToolsSection } from "@/components/technicians/ficha/sections/ToolsSection";
import { TransportSection } from "@/components/technicians/ficha/sections/TransportSection";
import { ErrorBox, LoadingBlock } from "@/components/ui";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useDocumentTitle } from "@/lib/hooks";
import { useCan } from "@/lib/permissions";
import { type FichaSectionKey, sectionFromParam } from "@/lib/technicians";
import type { Technician } from "@/lib/types";

/** A lista de Técnicos guarda aqui a URL com os filtros: o "← Técnicos" volta a ela. */
const LIST_STORAGE_KEY = "mf-tecnicos-lista";
const LIST_PATH = "/tecnicos";

const subscribeNothing = () => () => {};
function readListHref(): string {
  try {
    const saved = window.sessionStorage.getItem(LIST_STORAGE_KEY);
    return saved && (saved === LIST_PATH || saved.startsWith(`${LIST_PATH}?`)) ? saved : LIST_PATH;
  } catch {
    // Sem sessionStorage (bloqueado): a lista sem filtros.
    return LIST_PATH;
  }
}

/** Uma seção da ficha (só a da URL fica montada). */
function FichaSection({ section, tech, canEdit }: { section: FichaSectionKey; tech: Technician; canEdit: boolean }) {
  switch (section) {
    case "foto":
      return <PhotoSection tech={tech} canEdit={canEdit} />;
    case "endereco":
      return <AddressSection tech={tech} canEdit={canEdit} />;
    case "contato":
      return <ContactSection tech={tech} canEdit={canEdit} />;
    case "credenciais":
      return <CredentialsSection tech={tech} canEdit={canEdit} />;
    case "mini-biografia":
      return <BioSection tech={tech} canEdit={canEdit} />;
    case "dados-empresariais":
      return <CompanySection tech={tech} canEdit={canEdit} />;
    case "recebimento":
      return <PayoutMethodsSection tech={tech} />;
    case "dias-e-horarios":
      return <ScheduleSection tech={tech} />;
    case "transporte":
      return <TransportSection tech={tech} />;
    case "formacao":
      return <EducationSection tech={tech} />;
    case "aptidoes":
      return <SkillsSection tech={tech} />;
    case "ferramental":
      return <ToolsSection tech={tech} />;
    case "situacao":
      return <StatusSection tech={tech} canEdit={canEdit} />;
    case "equipe":
      return <TeamSection tech={tech} canEdit={canEdit} />;
    case "favoritos":
      return <FavoritesSection tech={tech} />;
    case "elo":
      return <EloSection tech={tech} canEdit={canEdit} />;
    case "historico":
      return <HistorySection tech={tech} />;
    default:
      // "dados-pessoais" e as seções de entregas futuras (fora do menu: sectionFromParam já devolve a padrão).
      return <PersonalDataSection tech={tech} canEdit={canEdit} />;
  }
}

export default function TechnicianFichaPage() {
  // A seção vem da URL (?secao=).
  return (
    <Suspense fallback={<LoadingBlock rows={4} />}>
      <TechnicianFicha />
    </Suspense>
  );
}

/**
 * Ficha do técnico em página própria (/tecnicos/{id}?secao=…): o cabeçalho, o menu com os grupos (os mesmos nomes do
 * app, mais a Gestão) e uma seção por vez, cada uma com Salvar próprio. Só com Visualizar, tudo para consulta.
 */
function TechnicianFicha() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const canView = useCan("base.technicians");
  const canEdit = useCan("base.technicians", "edit");
  const canPayouts = useCan("commercial.payouts");
  const listHref = useSyncExternalStore(subscribeNothing, readListHref, () => LIST_PATH);
  const valid = isUuid(id);
  // A chave de sempre do detalhe: o tempo real e o salvar das outras telas releem sozinhos.
  const query = useQuery({
    queryKey: ["technicians", "one", id],
    queryFn: ({ signal }) => api.get<Technician>(`/technicians/${id}`, undefined, { signal }),
    staleTime: 30_000,
    enabled: canView && valid,
  });
  const tech = query.data;
  useDocumentTitle(tech?.name);

  const groups = useMemo(() => fichaMenu(canPayouts), [canPayouts]);
  const param = searchParams.get("secao");
  // Formas de recebimento pedida sem Pagamentos: o aviso no lugar da seção (o item não está no menu).
  const paymentsDenied = param === "recebimento" && !canPayouts;
  const section = sectionFromParam(param, groups.flatMap((g) => g.sections.map((s) => s.key)));
  const shown = paymentsDenied ? "recebimento" : section;

  // Trocar de seção leva o foco ao título da seção nova (e a tela até ele, se ficou para cima).
  const loaded = !!tech;
  const previous = useRef<string | null>(null);
  useEffect(() => {
    if (!loaded) return;
    if (previous.current !== null && previous.current !== shown) {
      const heading = document.getElementById(FICHA_HEADING_ID);
      if (heading) {
        heading.focus({ preventScroll: true });
        if (heading.getBoundingClientRect().top < 72) heading.scrollIntoView({ block: "start" });
      }
    }
    previous.current = shown;
  }, [shown, loaded]);

  if (!canView) return <NoAccess kind="module" item="base.technicians" />;

  const notFound =
    !valid || (query.error instanceof ApiError && (query.error.status === 404 || query.error.status === 422));
  const back = (
    <Link href={listHref} className="mb-3 inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink">
      <ArrowLeft className="size-4" />
      Técnicos
    </Link>
  );

  if (notFound || !tech) {
    return (
      <div className="mx-auto max-w-7xl">
        {back}
        {notFound ? (
          <ErrorBox message="Técnico não encontrado." />
        ) : query.error && !query.isFetching ? (
          <ErrorBox message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
        ) : (
          <LoadingBlock rows={4} />
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl">
      {back}
      <FichaHeader tech={tech} />
      <div className="grid gap-5 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <FichaNav
          technicianId={tech.id}
          groups={groups}
          active={paymentsDenied ? null : section}
          blockedLabel={paymentsDenied ? { key: "recebimento", label: fichaLabel("recebimento") } : null}
        />
        <div className="min-w-0">
          {paymentsDenied ? (
            <SectionCard title={fichaLabel("recebimento")}>
              <p className="text-sm text-ink-muted">Formas de recebimento: só com acesso a Pagamentos.</p>
            </SectionCard>
          ) : (
            <FichaSection section={section} tech={tech} canEdit={canEdit} />
          )}
        </div>
      </div>
    </div>
  );
}
