"use client";

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Alert, RetryButton } from "@/components/ui/feedback";

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
  /** Falló la carga de /api/companies — el shell muestra el error con retry. */
  error: string | null;
  reload: () => void;
}

const CompanyContext = createContext<CompanyContextValue>({
  companies: [],
  activeCompany: null,
  setActiveCompany: () => {},
  loading: true,
  error: null,
  reload: () => {},
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
  const [error, setError] = useState<string | null>(null);
  const [intento, setIntento] = useState(0);
  const router = useRouter();
  const pathname = usePathname();

  const reload = useCallback(() => setIntento((n) => n + 1), []);

  useEffect(() => {
    let vivo = true;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch("/api/companies");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: unknown = await res.json();
        if (!Array.isArray(data)) throw new Error("respuesta inesperada");
        if (!vivo) return;
        const lista = data as Company[];
        setCompanies(lista);
        // Sólo una respuesta EXITOSA y vacía significa "sin empresas" — un
        // fetch fallido jamás debe mandar a onboarding ni fingir cartera vacía.
        if (lista.length === 0) {
          router.push("/onboarding");
          return;
        }
        const saved = localStorage.getItem("activeCompanyId");
        const found = lista.find((c) => c.id === saved) ?? lista[0] ?? null;
        setActiveCompanyState(found);
      } catch (e) {
        if (!vivo) return;
        console.error("[CompanyProvider] /api/companies falló:", e);
        setError("No se pudieron cargar tus empresas.");
      } finally {
        if (vivo) setLoading(false);
      }
    })();
    return () => {
      vivo = false;
    };
  }, [userId, router, pathname, intento]);

  function setActiveCompany(company: Company) {
    setActiveCompanyState(company);
    localStorage.setItem("activeCompanyId", company.id);
  }

  // Sin lista de empresas TODO el producto queda ciego (cada pantalla caería
  // en su rama "sin empresa" como si la cartera no existiera). Mejor decirlo
  // una sola vez, aquí, con salida.
  if (error && !loading) {
    return (
      <div className="mx-auto mt-24 max-w-md px-4">
        <Alert tone="danger" action={<RetryButton onClick={reload} />}>
          {error} Revisa tu conexión e intenta de nuevo.
        </Alert>
      </div>
    );
  }

  return (
    <CompanyContext.Provider
      value={{ companies, activeCompany, setActiveCompany, loading, error, reload }}
    >
      {children}
    </CompanyContext.Provider>
  );
}

export function useCompany() {
  return useContext(CompanyContext);
}
