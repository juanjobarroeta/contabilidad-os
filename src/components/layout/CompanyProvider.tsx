"use client";

import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";

interface Company {
  id: string;
  rfc: string;
  razonSocial: string;
  regimenFiscal: string;
  // Sólo presente para operadores de plataforma (que ven varios despachos):
  // permite agrupar el selector por despacho.
  despachoId?: string | null;
  despachoNombre?: string | null;
}

interface CompanyContextValue {
  companies: Company[];
  activeCompany: Company | null;
  setActiveCompany: (company: Company) => void;
  loading: boolean;
}

const CompanyContext = createContext<CompanyContextValue>({
  companies: [],
  activeCompany: null,
  setActiveCompany: () => {},
  loading: true,
});

export function CompanyProvider({
  userId,
  children,
}: {
  userId: string;
  children: ReactNode;
}) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [activeCompany, setActiveCompanyState] = useState<Company | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    fetch("/api/companies")
      .then((r) => r.json())
      .then((data: Company[]) => {
        setCompanies(data);
        if (data.length === 0) {
          router.push("/onboarding");
          return;
        }
        const saved = localStorage.getItem("activeCompanyId");
        const found = data.find((c) => c.id === saved) ?? data[0] ?? null;
        setActiveCompanyState(found);
      })
      .finally(() => setLoading(false));
  }, [userId, router, pathname]);

  function setActiveCompany(company: Company) {
    setActiveCompanyState(company);
    localStorage.setItem("activeCompanyId", company.id);
  }

  return (
    <CompanyContext.Provider value={{ companies, activeCompany, setActiveCompany, loading }}>
      {children}
    </CompanyContext.Provider>
  );
}

export function useCompany() {
  return useContext(CompanyContext);
}
