"use client";

// ─────────────────────────────────────────────────────────────────────────────
// 04 · e.firma — .cer / .key / contraseña → tres checks → (CSF vía e.firma o
// «Confirma 2 datos») → POST /api/companies → opinión 32-D.
//
// Todo es real: /api/onboarding/fiel lee el certificado y valida la llave con
// el mismo validador del alta; la empresa se crea con la e.firma (cifrada) y
// eso arranca sat-backfill; la 32-D sale de SatGo y queda en Cumplimiento.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState, type DragEvent } from "react";
import Link from "next/link";
import { FileText, KeyRound } from "lucide-react";
import { LINEAS, t } from "@/lib/onboarding/lineas";
import { REGIMENES_ALTA } from "@/lib/onboarding/regimenes";
import { Burbuja, Slot, useEscena } from "./escena";
import { cn } from "@/lib/utils";
import { solicitar } from "@/lib/onboarding/solicitar";

interface Archivo {
  nombre: string;
  b64: string;
  kb: number;
}
interface InfoCert {
  rfc: string;
  razonSocial: string;
  validoHasta: string | null;
  esFiel: boolean;
  vigente: boolean;
}
interface DatosFiscales {
  razonSocial: string;
  regimenFiscal: string;
  codigoPostal: string;
  domicilioFiscal: string;
  regimenes: Array<{ code: string; label: string; since: string | null }>;
  fechaInicioRegimen: string | null;
  csfObligaciones: string[];
  email: string;
  telefono: string;
  actividadEconomica: string;
}
type Check = "espera" | "run" | "ok" | "bad" | "nr";
type Fase = "archivos" | "validando" | "csf" | "confirma" | "creando" | "opinion" | "listo";

const espera = (ms: number, reducir: boolean) => new Promise((r) => setTimeout(r, reducir ? Math.min(ms, 120) : ms));

function leerB64(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] ?? "");
    r.onerror = () => rej(r.error);
    r.readAsDataURL(f);
  });
}

const fechaCorta = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : null;

async function json<T>(res: Response): Promise<T & { error?: string }> {
  return ((await res.json().catch(() => null)) ?? {}) as T & { error?: string };
}

export function PantallaFiel({
  onCreada,
  onListo,
  manualHref,
}: {
  /** La empresa ya existe (con e.firma): se guarda en el progreso. */
  onCreada: (companyId: string) => Promise<boolean>;
  onListo: () => void;
  manualHref: string;
}) {
  const { decir, festejar, mirar, tono, perfil, reducir } = useEscena();
  const [cer, setCer] = useState<Archivo | null>(null);
  const [key, setKey] = useState<Archivo | null>(null);
  const [password, setPassword] = useState("");
  const [mandato, setMandato] = useState(false);
  const [info, setInfo] = useState<InfoCert | null>(null);
  const [fase, setFase] = useState<Fase>("archivos");
  const [checks, setChecks] = useState<Record<"esFiel" | "vigente" | "llave", Check>>({ esFiel: "espera", vigente: "espera", llave: "espera" });
  const [error, setError] = useState<string | null>(null);
  const [datos, setDatos] = useState<DatosFiscales | null>(null);
  const [opinion, setOpinion] = useState<{ estado: "run" | "ok" | "warn"; texto: string; valor: string } | null>(null);
  const [sobre, setSobre] = useState<"cer" | "key" | null>(null);
  const [leyendoCsf, setLeyendoCsf] = useState(false);
  const refCert = useRef<HTMLDivElement>(null);
  const refChecks = useRef<HTMLUListElement>(null);
  const refOpi = useRef<HTMLDivElement>(null);
  const inCer = useRef<HTMLInputElement>(null);
  const inKey = useRef<HTMLInputElement>(null);
  const inCsf = useRef<HTMLInputElement>(null);
  const inPass = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void decir(t(LINEAS.fiel, tono));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function tomarArchivo(f: File | undefined, cual: "cer" | "key") {
    if (!f) return;
    try {
      setError(null);
      const nombre = f.name.toLowerCase();
      // Si lo soltaron en la caja equivocada, lo acomodamos por extensión.
      const real = nombre.endsWith(".key") ? "key" : nombre.endsWith(".cer") ? "cer" : cual;
      const a: Archivo = { nombre: f.name, b64: await leerB64(f), kb: Math.max(1, Math.round(f.size / 102.4) / 10) };
      if (real === "key") {
        setKey(a);
        setTimeout(() => inPass.current?.focus(), 50);
        mirar(inPass.current);
        void decir(LINEAS.llave);
        return;
      }
      setCer(a);
      setInfo(null);
      const res = await solicitar("/api/onboarding/fiel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accion: "leer", cer: a.b64 }),
      });
      const j = await json<InfoCert>(res);
      if (!res.ok) {
        setCer(null);
        setError(j.error ?? "No pude leer el certificado.");
        void decir(LINEAS.fielError(j.error ?? "no pude leer el certificado"));
        return;
      }
      setInfo(j);
      setTimeout(() => mirar(refCert.current), 50);
      if (!j.esFiel) {
        void decir(
          LINEAS.fielError("este certificado es del CSD (el sello para facturar), no de la e.firma. Sube el .cer de tu e.firma, el que usas para entrar al portal del SAT."),
        );
      } else if (!j.vigente) {
        void decir(LINEAS.fielError("el certificado está vencido. Renuévalo en el SAT y sube los archivos nuevos."));
      } else {
        await decir(LINEAS.certLeido(j.razonSocial || "tu empresa", j.rfc, fechaCorta(j.validoHasta)));
        mirar(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "No pude leer el archivo. Intenta de nuevo.");
    }
  }

  function soltar(e: DragEvent, cual: "cer" | "key") {
    e.preventDefault();
    setSobre(null);
    for (const f of Array.from(e.dataTransfer.files)) void tomarArchivo(f, cual);
  }

  async function conectar() {
    if (!cer || !key || !password || !mandato) return;
    try {
      setError(null);
      setFase("validando");
      setChecks({ esFiel: "run", vigente: "run", llave: "run" });
      mirar(refChecks.current);
      void decir(LINEAS.validando);
      const res = await solicitar("/api/onboarding/fiel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accion: "validar", cer: cer.b64, key: key.b64, password }),
      });
      const j = await json<{ ok: boolean; checks: { esFiel: boolean; vigente: boolean; llave: boolean | null } }>(res);
      if (!res.ok || !j.checks) {
        setFase("archivos");
        setChecks({ esFiel: "espera", vigente: "espera", llave: "espera" });
        setError(j.error ?? "No pude validar la e.firma.");
        return;
      }
      // Los checks se van marcando uno por uno (el resultado ya es real).
      const orden: Array<["esFiel" | "vigente" | "llave", boolean | null]> = [
        ["llave", j.checks.llave],
        ["vigente", j.checks.vigente],
        ["esFiel", j.checks.esFiel],
      ];
      for (const [k, v] of orden) {
        await espera(450, reducir);
        setChecks((c) => ({ ...c, [k]: v == null ? "nr" : v ? "ok" : "bad" }));
      }
      if (!j.ok) {
        setFase("archivos");
        setError(j.error ?? "La e.firma no es válida.");
        void decir(LINEAS.fielError(j.error ?? "la e.firma no es válida"));
        return;
      }
      festejar();
      setFase("csf");
      void decir(t(LINEAS.leyendoCsf, tono));
      const rc = await solicitar("/api/onboarding/fiel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accion: "csf", cer: cer.b64, key: key.b64, password }),
      }, 130_000);
      const jc = await json<{ datos: DatosFiscales | null }>(rc);
      const d = rc.ok ? jc.datos : null;
      if (d && d.regimenFiscal && /^\d{5}$/.test(d.codigoPostal)) {
        setDatos(d);
        await crear(d);
        return;
      }
      setDatos(
        d ?? {
          razonSocial: info?.razonSocial ?? "",
          regimenFiscal: info?.rfc.length === 12 ? "601" : "",
          codigoPostal: "",
          domicilioFiscal: "",
          regimenes: [],
          fechaInicioRegimen: null,
          csfObligaciones: [],
          email: "",
          telefono: "",
          actividadEconomica: "",
        },
      );
      setFase("confirma");
      void decir(LINEAS.confirmaDatos);
    } catch (e) {
      setFase("archivos");
      setChecks({ esFiel: "espera", vigente: "espera", llave: "espera" });
      setError(e instanceof Error ? e.message : "No pude conectar con el SAT. Intenta de nuevo.");
    }
  }

  async function leerCsfManual(f: File | undefined) {
    if (!f || !datos) return;
    setLeyendoCsf(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const res = await solicitar("/api/onboarding/parse-csf", { method: "POST", body: fd }, 130_000);
      const j = await json<{ extracted?: Record<string, unknown> }>(res);
      const x = j.extracted;
      if (!res.ok || !x) {
        setError(j.error ?? "No pude leer esa constancia.");
        return;
      }
      const s = (k: string) => (typeof x[k] === "string" ? (x[k] as string) : "");
      setDatos({
        ...datos,
        razonSocial: s("razonSocial") || datos.razonSocial,
        regimenFiscal: s("regimenFiscal") || datos.regimenFiscal,
        codigoPostal: s("codigoPostal") || datos.codigoPostal,
        fechaInicioRegimen: s("fechaInicioRegimen") || datos.fechaInicioRegimen,
        csfObligaciones: Array.isArray(x.obligaciones) ? (x.obligaciones as string[]) : datos.csfObligaciones,
        email: s("correo") || datos.email,
        telefono: s("telefono") || datos.telefono,
        actividadEconomica: s("actividadEconomica") || datos.actividadEconomica,
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No pude leer la constancia. Intenta de nuevo.");
    } finally {
      setLeyendoCsf(false);
    }
  }

  async function crear(d: DatosFiscales, desdeConfirma = false) {
    if (!cer || !key || !info) return;
    try {
      setFase("creando");
      setError(null);
      void decir(LINEAS.creando);
      const regimenes =
        d.regimenes.length > 0
          ? d.regimenes
          : [{ code: d.regimenFiscal, label: REGIMENES_ALTA.find((r) => r.value === d.regimenFiscal)?.label ?? d.regimenFiscal, since: d.fechaInicioRegimen }];
      const res = await solicitar("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rfc: info.rfc,
          razonSocial: d.razonSocial || info.razonSocial,
          regimenFiscal: d.regimenFiscal,
          codigoPostal: d.codigoPostal,
          domicilioFiscal: d.domicilioFiscal || undefined,
          email: d.email || undefined,
          telefono: d.telefono || undefined,
          actividadEconomica: d.actividadEconomica || undefined,
          fielCer: cer.b64,
          fielKey: key.b64,
          fielPassword: password,
          aceptaMandatoEfirma: true,
          fechaInicioRegimen: d.fechaInicioRegimen ?? undefined,
          regimenes,
          csfObligaciones: d.csfObligaciones,
          // El plan se elige antes (precios → pago) o lo pone el despacho que invitó.
          satBackfillYears: 5,
        }),
      }, 130_000);
      const j = await json<{ id?: string; companyId?: string; codigo?: string; code?: string }>(res);
      let companyId = res.ok ? j.id : undefined;
      // RFC ya dado de alta y el usuario ya entra: le guardamos la e.firma
      // (mismo PATCH que Configuración, que la valida y arranca la descarga) y
      // seguimos con esa empresa.
      if (!companyId && res.status === 409 && j.companyId) {
        const rp = await solicitar(`/api/companies/${j.companyId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fielCer: cer.b64, fielKey: key.b64, fielPassword: password, aceptaMandatoEfirma: true }),
        }, 130_000);
        if (rp.ok) companyId = j.companyId;
        else j.error = (await json(rp)).error ?? j.error;
      }
      if (!companyId) {
        setFase(desdeConfirma ? "confirma" : "archivos");
        setError(j.error ?? "No se pudo dar de alta la empresa. Intenta de nuevo en un momento.");
        void decir(LINEAS.fielError(j.error ?? "no se pudo dar de alta la empresa"));
        return;
      }
      if (!await onCreada(companyId)) {
        setFase(desdeConfirma ? "confirma" : "archivos");
        setError("La empresa se creó, pero no pude guardar tu avance. Reintenta el guardado antes de seguir.");
        return;
      }
      festejar();
      await decir(LINEAS.conectado);
      setFase("opinion");
      setOpinion({ estado: "run", texto: "Consultando al SAT…", valor: "" });
      setTimeout(() => mirar(refOpi.current), 50);
      void decir(t(LINEAS.opinion, tono));
      const ro = await solicitar("/api/onboarding/opinion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId }),
      }, 130_000).catch(() => null);
      const jo = ro ? await json<{ resultado?: string }>(ro) : null;
      if (ro?.ok && jo?.resultado) {
        const positiva = jo.resultado === "POSITIVA";
        setOpinion({
          estado: positiva ? "ok" : "warn",
          texto: "Consultada hoy · la encuentras en Cumplimiento",
          valor: positiva ? "Positiva ✓" : jo.resultado === "NEGATIVA" ? "Negativa" : "Sin opinión",
        });
        if (positiva) festejar();
        await decir(t(LINEAS.opinionResultado(jo.resultado), tono));
      } else {
        setOpinion({ estado: "warn", texto: "El SAT no respondió; la pido más tarde", valor: "Pendiente" });
        await decir(LINEAS.opinionNoDisponible);
      }
      setFase("listo");
      mirar(null);
      await espera(1200, reducir);
      onListo();
    } catch (e) {
      setFase(desdeConfirma ? "confirma" : "archivos");
      setError(e instanceof Error ? e.message : "No pude terminar el alta. Intenta de nuevo.");
    }
  }

  const listo = !!(cer && key && password && mandato && info?.esFiel && info.vigente);
  const ocupado = fase !== "archivos" && fase !== "confirma";
  const icono = (c: Check) => (c === "ok" ? "✓" : c === "bad" ? "✕" : c === "nr" ? "–" : "");
  const claseCheck = (c: Check) => (c === "run" ? "run" : c === "ok" ? "ok" : c === "bad" ? "bad" : "");

  return (
    <div className="ob-cols">
      <div className="ob-lcol">
        <Slot />
        <Burbuja />
        <button type="button" className="ob-why" onClick={() => void decir(LINEAS.fielPorQue)}>
          ¿Por qué la e.firma y no la contraseña del SAT?
        </button>
      </div>
      <div className="ob-rcol">
        <p className="ob-kick">Paso 3 · Conectar con el SAT</p>
        <h1>{perfil === "despacho" ? "Conecta la e.firma de tu primer cliente" : "Conecta tu e.firma"}</h1>
        <p className="ob-sub">Con ella descargo del SAT todo tu historial de facturas. Son dos archivos y su contraseña.</p>
        <div className="ob-panel" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="ob-drops">
            {(["cer", "key"] as const).map((cual) => {
              const a = cual === "cer" ? cer : key;
              const Icon = cual === "cer" ? FileText : KeyRound;
              return (
                <button
                  key={cual}
                  type="button"
                  disabled={ocupado}
                  className={cn("ob-drop", a && "ok", sobre === cual && "over")}
                  onClick={() => (cual === "cer" ? inCer : inKey).current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setSobre(cual);
                  }}
                  onDragLeave={() => setSobre(null)}
                  onDrop={(e) => soltar(e, cual)}
                >
                  <Icon size={22} />
                  <b>{cual === "cer" ? "Certificado (.cer)" : "Llave privada (.key)"}</b>
                  <span>{a ? `${a.nombre} · ${a.kb} KB` : cual === "cer" ? "Arrástralo o haz clic" : "Arrástrala o haz clic"}</span>
                </button>
              );
            })}
            <input ref={inCer} type="file" accept=".cer" hidden onChange={(e) => void tomarArchivo(e.target.files?.[0], "cer")} />
            <input ref={inKey} type="file" accept=".key" hidden onChange={(e) => void tomarArchivo(e.target.files?.[0], "key")} />
          </div>

          {info && (
            <div ref={refCert} className="ob-cert">
              <span>Razón social</span>
              <span>RFC</span>
              <span>Vigencia</span>
              <b>{info.razonSocial || "—"}</b>
              <b className="money">{info.rfc}</b>
              <b>{info.validoHasta ? `hasta ${fechaCorta(info.validoHasta)}` : "—"}</b>
            </div>
          )}

          <input
            ref={inPass}
            className="ob-field"
            type="password"
            autoComplete="off"
            placeholder="Contraseña de la llave privada"
            value={password}
            disabled={ocupado}
            onChange={(e) => setPassword(e.target.value)}
          />

          <label className="ob-mandato">
            <input type="checkbox" checked={mandato} disabled={ocupado} onChange={(e) => setMandato(e.target.checked)} />
            <span>
              Declaro que estoy facultado para usar esta e.firma y acepto la{" "}
              <a href="/legal/mandato-efirma" target="_blank" rel="noopener noreferrer">
                Autorización de uso de la e.firma
              </a>
              : ContabilidadOS la usará únicamente para autenticarse ante el SAT y descargar tu información fiscal.
            </span>
          </label>

          {fase !== "archivos" || checks.llave !== "espera" ? (
            <ul ref={refChecks} className="ob-checks">
              <li className={claseCheck(checks.llave)}>
                <span className="ob-st">{icono(checks.llave)}</span>Llave, certificado y contraseña coinciden
              </li>
              <li className={claseCheck(checks.vigente)}>
                <span className="ob-st">{icono(checks.vigente)}</span>Certificado vigente ante el SAT
              </li>
              <li className={claseCheck(checks.esFiel)}>
                <span className="ob-st">{icono(checks.esFiel)}</span>Es e.firma (no el sello para facturar)
              </li>
            </ul>
          ) : null}

          {fase === "confirma" && datos && (
            <div className="ob-confirma">
              <b style={{ fontSize: 14 }}>Confirma 2 datos</b>
              <select
                aria-label="Régimen fiscal"
                value={datos.regimenFiscal}
                onChange={(e) => setDatos({ ...datos, regimenFiscal: e.target.value, regimenes: [] })}
              >
                <option value="">Régimen fiscal…</option>
                {REGIMENES_ALTA.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
              <input
                className="ob-field"
                inputMode="numeric"
                maxLength={5}
                placeholder="Código postal del domicilio fiscal"
                value={datos.codigoPostal}
                onChange={(e) => setDatos({ ...datos, codigoPostal: e.target.value.replace(/\D/g, "").slice(0, 5) })}
              />
              <div className="ob-acts">
                <button
                  type="button"
                  className="ob-btn p"
                  disabled={!datos.regimenFiscal || datos.codigoPostal.length !== 5}
                  onClick={() => void crear(datos, true)}
                >
                  Confirmar y conectar
                </button>
                <button type="button" className="ob-btn g" disabled={leyendoCsf} onClick={() => inCsf.current?.click()}>
                  {leyendoCsf ? "Leyendo…" : "Subir mi constancia (PDF)"}
                </button>
                <input ref={inCsf} type="file" accept="application/pdf" hidden onChange={(e) => void leerCsfManual(e.target.files?.[0])} />
              </div>
            </div>
          )}

          {opinion && (
            <div ref={refOpi} className={cn("ob-opi", opinion.estado === "ok" && "ok", opinion.estado === "warn" && "warn")}>
              <span className="ob-st">{opinion.estado === "ok" ? "✓" : opinion.estado === "warn" ? "!" : ""}</span>
              <div>
                <b>Opinión de cumplimiento (32-D)</b>
                <span className="s">{opinion.texto}</span>
              </div>
              <em>{opinion.valor}</em>
            </div>
          )}

          {error && <div className="ob-err">{error}</div>}

          {(fase === "archivos" || fase === "validando") && (
            <div className="ob-acts">
              <button type="button" className="ob-btn p" disabled={!listo || fase !== "archivos"} onClick={() => void conectar()}>
                Conectar con el SAT
              </button>
              <span className="ob-fine">Se guarda cifrada. Puedes revocarla cuando quieras.</span>
            </div>
          )}
        </div>
        <p className="ob-fine">
          ¿No tienes tu e.firma a la mano?{" "}
          <Link href={manualHref} className="font-semibold text-cos-brand-ink hover:underline">
            Conectar después
          </Link>{" "}
          (das de alta tus datos a mano y la conectas desde Configuración; sin ella no descargo tu historial).
        </p>
      </div>
    </div>
  );
}
