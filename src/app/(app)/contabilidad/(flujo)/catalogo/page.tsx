"use client";
import { useCompany } from "@/components/layout/CompanyProvider";
import { CatalogoPanel } from "@/components/contabilidad/CatalogoPanel";
export default function CatalogoPage() {
  const { activeCompany } = useCompany();
  return activeCompany ? <CatalogoPanel companyId={activeCompany.id} /> : null;
}
