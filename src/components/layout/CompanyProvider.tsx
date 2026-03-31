"use client";

import { createContext, useContext, useState, useEffect, ReactNode } from "react";

interface Company {
  id: string;
  rfc: string;
  razonSocial: string;
  regimenFiscal: string;
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

  useEffect(() => {
    fetch("/api/companies")
      .then((r) => r.json())
      .then((data: Company[]) => {
        setCompanies(data);
        const saved = localStorage.getItem("activeCompanyId");
        const found = data.find((c) => c.id === saved) ?? data[0] ?? null;
        setActiveCompanyState(found);
      })
      .finally(() => setLoading(false));
  }, [userId]);

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
