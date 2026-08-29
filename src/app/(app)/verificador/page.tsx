"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Verificador — herramienta transversal de consulta de identificadores
// fiscales (no depende de la empresa activa). Valida estructura + dígito
// verificador de RFC/CURP/NSS al instante (offline) y, para RFC, cruza la
// lista 69-B del SAT y muestra lo que la cartera ya sabe de ese RFC.
// Historial de la sesión abajo (las consultas quedan además en bitácora).
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import {
  ScanSearch, Loader2, CheckCircle2, XCircle, AlertTriangle, ShieldCheck,
  Building2, Users, UserRound, Search,
} from "lucide-react";
import { Card } from "@/components/ui";
import { DirectorioNav } from "@/components/layout/DirectorioNav";

type Tipo = "RFC" | "CURP" | "NSS";

interface Estructura {
  valor: string;
  formatoValido: boolean;
  digitoVerificador: "valido" | "invalido" | "no-evaluable";
  detalle: string | null;
  esPersonaMoral?: boolean;
}

interface Resultado {
  tipo: Tipo;
  estructura: Estructura;
  lista69b?: { situacion: string | null; listaDescargadaAt?: string; rfcsEnLista?: number; error?: string } | null;
  conocidos?: {
    origen: "EMPRESA" | "CLIENTE" | "EMPLEADO";
    nombre: string;
    empresa: string | null;
    codigoPostal: string | null;
    regimenFiscal: string | null;
    rfc: string | null;
    curp: string | null;
    nss: string | null;
  }[];
}

const PLACEHOLDER: Record<Tipo, string> = {
  RFC: "Ej. COOF821223RC4 (PF) o REYES HUERTA… ABC680524P76 (PM)",
  CURP: "18 caracteres — Ej. COOF821223HPLRRR05",
  NSS: "11 dígitos del IMSS",
};

const ORIGEN_META = {
  EMPRESA: { label: "Empresa de tu cartera", icon: Building2 },
  CLIENTE: { label: "Cliente", icon: Users },
  EMPLEADO: { label: "Empleado", icon: UserRound },
} as const;

export default function VerificadorPage() {
  const [tipo, setTipo] = useState<Tipo>("RFC");
  const [valor, setValor] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const [historial, setHistorial] = useState<{ tipo: Tipo; valor: string; ok: boolean }[]>([]);

  async function consultar(t: Tipo = tipo, v: string = valor) {
    const limpio = v.trim();
    if (!limpio) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/verificador?${t.toLowerCase()}=${encodeURIComponent(limpio)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "No se pudo consultar");
      setResultado(data);
      const ok =
        data.estructura.formatoValido &&
        data.estructura.digitoVerificador === "valido" &&
        !(data.lista69b?.situacion === "DEFINITIVO" || data.lista69b?.situacion === "PRESUNTO");
      setHistorial((h) => [{ tipo: t, valor: data.estructura.valor, ok }, ...h.filter((x) => x.valor !== data.estructura.valor)].slice(0, 8));
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo consultar");
      setResultado(null);
    } finally {
      setBusy(false);
    }
  }

  const e = resultado?.estructura;
  const l69 = resultado?.lista69b;
  const enLista = l69?.situacion === "DEFINITIVO" || l69?.situacion === "PRESUNTO";

  return (
    <div>
    <DirectorioNav />
    <div className="mx-auto max-w-[760px] px-4 py-6 sm:px-8 sm:py-8">
      <div className="flex items-center gap-3">
        <ScanSearch className="h-7 w-7 text-cos-brand-ink" />
        <div>
          <h1 className="text-[26px] font-semibold leading-[1.05] tracking-[-0.03em] text-cos-ink">Verificador</h1>
          <p className="mt-0.5 text-[14px] text-cos-ink-soft">
            Valida RFC, CURP y NSS al instante y cruza la lista 69-B del SAT — para cualquier RFC, sea o no de tu cartera.
          </p>
        </div>
      </div>

      {/* búsqueda */}
      <Card className="mt-5 rounded-card border-cos-line p-5 shadow-card">
        <div className="flex gap-2">
          {(["RFC", "CURP", "NSS"] as Tipo[]).map((t) => (
            <button key={t} onClick={() => { setTipo(t); setResultado(null); setError(""); }}
              className={`rounded-full border px-4 py-1.5 text-[13px] font-medium ${
                tipo === t ? "border-cos-brand bg-cos-brand text-white" : "border-cos-line text-cos-ink-soft hover:border-cos-brand"
              }`}>
              {t}
            </button>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <div className="flex flex-1 items-center gap-2 rounded-control border border-cos-line bg-cos-card px-3 text-cos-ink-faint">
            <Search className="h-4 w-4" />
            <input
              value={valor}
              onChange={(ev) => setValor(ev.target.value.toUpperCase())}
              onKeyDown={(ev) => ev.key === "Enter" && consultar()}
              placeholder={PLACEHOLDER[tipo]}
              className="flex-1 border-0 bg-transparent py-2.5 font-mono text-[14px] text-cos-ink outline-none"
              autoFocus
            />
          </div>
          <button onClick={() => consultar()} disabled={busy || !valor.trim()}
            className="flex items-center gap-2 rounded-control bg-cos-brand px-5 py-2.5 text-[14px] font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanSearch className="h-4 w-4" />}
            Verificar
          </button>
        </div>
        {error && <p className="mt-2 text-[13px] text-cos-red-ink">{error}</p>}
      </Card>

      {/* resultado */}
      {resultado && e && (
        <Card className="mt-4 rounded-card border-cos-line p-5 shadow-card">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono text-[17px] font-bold text-cos-ink">{e.valor}</span>
            <span className="text-[12.5px] text-cos-ink-faint">
              {resultado.tipo}{resultado.tipo === "RFC" ? (e.esPersonaMoral ? " · Persona moral" : " · Persona física") : ""}
            </span>
          </div>

          {/* estructura */}
          <div className="mt-3 flex flex-wrap gap-2">
            <Chip ok={e.formatoValido} label={e.formatoValido ? "Formato válido" : "Formato inválido"} />
            {e.digitoVerificador !== "no-evaluable" && (
              <Chip ok={e.digitoVerificador === "valido"}
                label={e.digitoVerificador === "valido" ? "Dígito verificador correcto" : "Dígito verificador NO cuadra"} />
            )}
            {resultado.tipo === "RFC" && l69 && !l69.error && (
              enLista ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-cos-red-tint px-3 py-1 text-[12.5px] font-semibold text-cos-red-ink">
                  <AlertTriangle className="h-3.5 w-3.5" /> 69-B: {l69.situacion}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-cos-jade-tint px-3 py-1 text-[12.5px] font-semibold text-cos-jade-ink">
                  <ShieldCheck className="h-3.5 w-3.5" /> No aparece en la lista 69-B
                </span>
              )
            )}
          </div>
          {e.detalle && <p className="mt-2 text-[13px] text-cos-amber-ink">{e.detalle}</p>}
          {l69?.error && (
            <p className="mt-2 text-[13px] text-cos-ink-faint">Lista 69-B no disponible en este momento: {l69.error}</p>
          )}
          {enLista && (
            <p className="mt-2 rounded-[10px] bg-cos-red-tint px-3 py-2.5 text-[13px] text-cos-red-ink">
              {l69?.situacion === "DEFINITIVO"
                ? "EFOS definitivo (Art. 69-B CFF): las deducciones y el IVA acreditable de CFDIs de este RFC son improcedentes salvo que se acredite materialidad."
                : "Presunto en 69-B: riesgo de que las operaciones con este RFC se vuelvan improcedentes si pasa a definitivo — resguarda evidencia de materialidad."}
            </p>
          )}

          {/* lo que tu cartera ya sabe (identidad cruzada, estilo check.id) */}
          {resultado.conocidos && resultado.conocidos.length > 0 && (
            <div className="mt-4 border-t border-cos-line pt-3">
              <p className="mb-2 text-[12.5px] font-semibold uppercase tracking-[0.03em] text-cos-ink-faint">
                Lo que tu cartera ya sabe de este {resultado.tipo}
              </p>
              {resultado.conocidos.map((c, i) => {
                const meta = ORIGEN_META[c.origen];
                return (
                  <div key={i} className="flex items-start gap-2.5 border-b border-cos-line py-2 text-[13px] last:border-0">
                    <meta.icon className="mt-0.5 h-4 w-4 flex-none text-cos-ink-faint" />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-cos-ink">
                        {c.nombre}
                        <span className="ml-2 rounded-full bg-cos-slate-tint px-2 py-0.5 text-[10.5px] font-medium text-cos-ink-soft">{meta.label}</span>
                      </p>
                      <p className="text-[12px] text-cos-ink-faint">
                        {[c.empresa && `en ${c.empresa}`, c.codigoPostal && `CP ${c.codigoPostal}`, c.regimenFiscal && `régimen ${c.regimenFiscal}`]
                          .filter(Boolean).join(" · ") || "—"}
                      </p>
                      {/* Identidad cruzada: lo que hace útil buscar por cualquiera de los tres. */}
                      {(c.rfc || c.curp || c.nss) && (
                        <div className="mt-1 grid gap-x-4 gap-y-0.5 font-mono text-[12px] text-cos-ink-soft sm:grid-cols-3">
                          {c.rfc && <span><span className="font-sans text-cos-ink-faint">RFC </span>{c.rfc}</span>}
                          {c.curp && <span><span className="font-sans text-cos-ink-faint">CURP </span>{c.curp}</span>}
                          {c.nss && <span><span className="font-sans text-cos-ink-faint">NSS </span>{c.nss}</span>}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              <p className="mt-1.5 text-[11.5px] text-cos-ink-faint">
                Datos validados por el SAT al timbrar o extraídos de constancias — no una consulta al padrón en vivo.
              </p>
            </div>
          )}
          {resultado.conocidos && resultado.conocidos.length === 0 && e.formatoValido && (
            <p className="mt-3 text-[12.5px] text-cos-ink-faint">
              Este {resultado.tipo} no aparece en tu cartera (empresas, clientes o empleados visibles para ti).
            </p>
          )}
        </Card>
      )}

      {/* historial de la sesión */}
      {historial.length > 0 && (
        <Card className="mt-4 rounded-card border-cos-line p-4 shadow-card">
          <p className="mb-1.5 text-[12.5px] font-semibold uppercase tracking-[0.03em] text-cos-ink-faint">Consultas recientes</p>
          <div className="flex flex-wrap gap-2">
            {historial.map((h) => (
              <button key={h.valor} onClick={() => { setTipo(h.tipo); setValor(h.valor); consultar(h.tipo, h.valor); }}
                className="inline-flex items-center gap-1.5 rounded-full border border-cos-line px-3 py-1 font-mono text-[12px] text-cos-ink-soft hover:border-cos-brand">
                {h.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-cos-jade-ink" /> : <XCircle className="h-3.5 w-3.5 text-cos-red-ink" />}
                {h.valor}
              </button>
            ))}
          </div>
        </Card>
      )}

      <p className="mt-4 text-[12px] leading-relaxed text-cos-ink-faint">
        La validación de estructura usa los algoritmos oficiales de dígito verificador (SAT / RENAPO / IMSS) y detecta
        errores de captura al instante; no consulta el padrón en vivo. La lista 69-B se descarga del SAT y se refresca
        cada 12 horas. Cada consulta queda registrada en la bitácora.
      </p>
    </div>
    </div>
  );
}

function Chip({ ok, label }: { ok: boolean; label: string }) {
  return ok ? (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-cos-jade-tint px-3 py-1 text-[12.5px] font-semibold text-cos-jade-ink">
      <CheckCircle2 className="h-3.5 w-3.5" /> {label}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-cos-red-tint px-3 py-1 text-[12.5px] font-semibold text-cos-red-ink">
      <XCircle className="h-3.5 w-3.5" /> {label}
    </span>
  );
}
