"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { NoAccess } from "@/components/NoAccess";
import { isUuid } from "@/components/operacao/hooks";
import { FichaHeader } from "@/components/technicians/ficha/FichaHeader";
import { fichaDenied, fichaLabel, fichaMenu, FichaNav } from "@/components/technicians/ficha/FichaNav";
import { FICHA_HEADING_ID, SectionCard } from "@/components/technicians/ficha/SectionCard";
import { AddressSection } from "@/components/technicians/ficha/sections/AddressSection";
import { AreasSection } from "@/components/technicians/ficha/sections/AreasSection";
import { BioSection } from "@/components/technicians/ficha/sections/BioSection";
import { CompanySection } from "@/components/technicians/ficha/sections/CompanySection";
import { ContactSection } from "@/components/technicians/ficha/sections/ContactSection";
import { CredentialsSection } from "@/components/technicians/ficha/sections/CredentialsSection";
import { DocumentsSection } from "@/components/technicians/ficha/sections/DocumentsSection";
import { EducationSection } from "@/components/technicians/ficha/sections/EducationSection";
import { EloSection } from "@/components/technicians/ficha/sections/EloSection";
import { FavoritesSection } from "@/components/technicians/ficha/sections/FavoritesSection";
import { HistorySection } from "@/components/technicians/ficha/sections/HistorySection";
import { InternalFilesSection } from "@/components/technicians/ficha/sections/InternalFilesSection";
import { PayoutMethodsSection } from "@/components/technicians/ficha/sections/PayoutMethodsSection";
import { PersonalDataSection } from "@/components/technicians/ficha/sections/PersonalDataSection";
import { PhotoSection } from "@/components/technicians/ficha/sections/PhotoSection";
import { RatingsSection } from "@/components/technicians/ficha/sections/RatingsSection";
import { ResumeSection } from "@/components/technicians/ficha/sections/ResumeSection";
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
    case "documentos":
      return <DocumentsSection tech={tech} canEdit={canEdit} />;
    case "recebimento":
      return <PayoutMethodsSection tech={tech} />;
    case "dias-e-horarios":
      return <ScheduleSection tech={tech} canEdit={canEdit} />;
    case "transporte":
      return <TransportSection tech={tech} canEdit={canEdit} />;
    case "curriculo":
      return <ResumeSection tech={tech} canEdit={canEdit} />;
    case "formacao":
      return <EducationSection tech={tech} canEdit={canEdit} />;
    case "areas-de-atuacao":
      return <AreasSection tech={tech} canEdit={canEdit} />;
    case "aptidoes":
      return <SkillsSection tech={tech} canEdit={canEdit} />;
    case "ferramental":
      return <ToolsSection tech={tech} canEdit={canEdit} />;
    case "situacao":
      return <StatusSection tech={tech} canEdit={canEdit} />;
    case "equipe":
      return <TeamSection tech={tech} canEdit={canEdit} />;
    case "favoritos":
      return <FavoritesSection tech={tech} canEdit={canEdit} />;
    case "avaliacoes":
      return <RatingsSection tech={tech} canEdit={canEdit} />;
    case "elo":
      return <EloSection tech={tech} canEdit={canEdit} />;
    case "anexos":
      return <InternalFilesSection tech={tech} canEdit={canEdit} />;
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

  const groups = useMemo(() => fichaMenu(canPayouts, canEdit), [canPayouts, canEdit]);
  const param = searchParams.get("secao");
  // Formas de recebimento sem Pagamentos ou Anexos internos sem Técnicos em Editar: o aviso no lugar da seção (o item
  // não está no menu).
  const denied = fichaDenied(param, canPayouts, canEdit);
  const section = sectionFromParam(param, groups.flatMap((g) => g.sections.map((s) => s.key)));
  const shown = denied ? denied.key : section;

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
          active={denied ? null : section}
          blockedLabel={denied ? { key: denied.key, label: fichaLabel(denied.key) } : null}
        />
        {/* Por técnico: indo de uma ficha para outra (Ctrl+K, aviso), a seção recomeça com os dados do novo, sem levar o
            que estava digitado no anterior. */}
        <div key={tech.id} className="min-w-0">
          {denied ? (
            <SectionCard title={fichaLabel(denied.key)}>
              <p className="text-sm text-ink-muted">{denied.text}</p>
            </SectionCard>
          ) : (
            <FichaSection section={section} tech={tech} canEdit={canEdit} />
          )}
        </div>
      </div>
    </div>
  );
}
