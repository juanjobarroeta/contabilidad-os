"use client";

// 06 · Bancos y 07 · Equipo — opcionales, ambos con APIs que ya existen:
//   · Bancos: POST /api/bancos registra la cuenta; el estado de cuenta se sube
//     después en Bancos (no hay conexión directa al banco en el alta).
//   · Equipo: con despacho → POST /api/despacho/members; sin despacho →
//     POST /api/companies/[id]/members. Dan acceso de inmediato y devuelven la
//     contraseña temporal de quien no tenía cuenta (no se manda correo).

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Plus, X } from "lucide-react";
import { LINEAS } from "@/lib/onboarding/lineas";
import { Burbuja, Slot, useEscena } from "./escena";
import { cn } from "@/lib/utils";

const BANCOS: Array<[string, string]> = [
  ["BBVA", "BB"],
  ["Santander", "SA"],
  ["Banorte", "BN"],
  ["Banamex", "BX"],
  ["HSBC", "HS"],
  ["Scotiabank", "SC"],
  ["Banregio", "BR"],
  ["BanBajío", "BJ"],
  ["Otro", "··"],
];

export function PantallaBancos({ companyId, onSeguir }: { companyId: string; onSeguir: () => void }) {
  const { decir, festejar, mirar } = useEscena();
  const [banco, setBanco] = useState<string | null>(null);
  const [otro, setOtro] = useState("");
  const [nombre, setNombre] = useState("");
  const [numero, setNumero] = useState("");
  const [clabe, setClabe] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [listo, setListo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refForm = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void decir(LINEAS.bancos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function elegir(b: string, el: HTMLElement) {
    if (listo) return;
    setBanco(b);
    if (!nombre || nombre.startsWith("Cheques ")) setNombre(b === "Otro" ? "" : `Cheques ${b}`);
    mirar(el);
    void decir(LINEAS.bancoElegido(b === "Otro" ? "Tu banco" : b));
    setTimeout(() => mirar(refForm.current), 600);
  }

  async function registrar() {
    const nombreBanco = banco === "Otro" ? otro.trim() : banco;
    if (!nombreBanco || !nombre.trim() || !numero.trim()) return;
    setEnviando(true);
    setError(null);
    try {
      const res = await fetch("/api/bancos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId,
          banco: nombreBanco,
          nombre: nombre.trim(),
          numeroCuenta: numero.trim(),
          clabe: clabe.trim() || undefined,
          moneda: "MXN",
        }),
      });
      const j = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(j?.error ?? "No pude registrar la cuenta.");
        return;
      }
      setListo(`${nombre.trim()} ••${numero.trim().slice(-4)}`);
      festejar();
      void decir(LINEAS.bancoListo);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="ob-cols">
      <div className="ob-lcol">
        <Slot />
        <Burbuja />
      </div>
      <div className="ob-rcol">
        <p className="ob-kick">Paso 5 · Bancos · opcional</p>
        <h1>Registra tu cuenta de banco</h1>
        <p className="ob-sub">
          Con tus movimientos cruzo cada pago con su factura. Sin banco, tu estado de resultados cuadra; tu balance tiene que esperar.
        </p>
        <div className="ob-banks">
          {BANCOS.map(([n, i]) => (
            <button key={n} type="button" className={cn("ob-bank", banco === n && "on")} disabled={!!listo} onClick={(e) => elegir(n, e.currentTarget)}>
              <i>{i}</i>
              {n}
            </button>
          ))}
        </div>
        {banco && !listo && (
          <div ref={refForm} className="ob-panel" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {banco === "Otro" && <input className="ob-field" placeholder="Nombre del banco" value={otro} onChange={(e) => setOtro(e.target.value)} />}
            <input className="ob-field" placeholder="Nombre de la cuenta (p.ej. Cheques empresarial)" value={nombre} onChange={(e) => setNombre(e.target.value)} />
            <div className="ob-row2">
              <input className="ob-field" inputMode="numeric" placeholder="Número de cuenta" value={numero} onChange={(e) => setNumero(e.target.value.replace(/\s/g, ""))} />
              <input
                className="ob-field"
                inputMode="numeric"
                maxLength={18}
                placeholder="CLABE (opcional)"
                value={clabe}
                onChange={(e) => setClabe(e.target.value.replace(/\D/g, "").slice(0, 18))}
              />
            </div>
            {error && <div className="ob-err">{error}</div>}
          </div>
        )}
        {listo && (
          <div className="ob-okline">
            <Check size={18} strokeWidth={2.5} />
            {listo} registrada · sube su estado de cuenta en Bancos
          </div>
        )}
        <div className="ob-acts">
          {!listo && (
            <button
              type="button"
              className="ob-btn p"
              disabled={!banco || enviando || !nombre.trim() || !numero.trim() || (banco === "Otro" && !otro.trim())}
              onClick={() => void registrar()}
            >
              {enviando ? "Registrando…" : "Registrar cuenta"}
            </button>
          )}
          <button type="button" className={cn("ob-btn", listo ? "p" : "g")} onClick={onSeguir}>
            {listo ? "Continuar" : "Lo hago después"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 07 · Equipo ─────────────────────────────────────────────────────────────

interface Invitado {
  email: string;
  rol: string;
}
interface Enviado {
  email: string;
  tempPassword: string | null;
  error?: string;
}

const ROLES_DESPACHO = [
  { label: "Contador", role: "ACCOUNTANT" },
  { label: "Socio (administra)", role: "ADMIN" },
];
const ROLES_EMPRESA = [
  { label: "Contador externo", role: "ACCOUNTANT" },
  { label: "Administración", role: "ADMIN" },
  { label: "Sólo lectura", role: "VIEWER" },
];

export function PantallaEquipo({
  companyId,
  despachoAdmin,
  onSeguir,
}: {
  companyId: string;
  /** El usuario administra un despacho: invita a su equipo del despacho. */
  despachoAdmin: boolean;
  onSeguir: () => void;
}) {
  const { decir, festejar, perfil } = useEscena();
  const roles = despachoAdmin ? ROLES_DESPACHO : ROLES_EMPRESA;
  const [filas, setFilas] = useState<Invitado[]>([{ email: "", rol: roles[0].role }]);
  const [enviando, setEnviando] = useState(false);
  const [enviados, setEnviados] = useState<Enviado[]>([]);
  const [copiado, setCopiado] = useState<string | null>(null);

  useEffect(() => {
    void decir(LINEAS.equipo(perfil));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function invitar() {
    const lista = filas.map((f) => ({ ...f, email: f.email.trim().toLowerCase() })).filter((f) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email));
    if (!lista.length) {
      void decir(LINEAS.equipoVacio);
      return;
    }
    setEnviando(true);
    const resultado: Enviado[] = [];
    for (const f of lista) {
      const url = despachoAdmin ? "/api/despacho/members" : `/api/companies/${companyId}/members`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: f.email, role: f.rol }),
      });
      const j = (await res.json().catch(() => null)) as { tempPassword?: string | null; error?: string } | null;
      resultado.push(res.ok ? { email: f.email, tempPassword: j?.tempPassword ?? null } : { email: f.email, tempPassword: null, error: j?.error ?? "No se pudo" });
    }
    setEnviados((e) => [...e, ...resultado]);
    setFilas([{ email: "", rol: roles[0].role }]);
    setEnviando(false);
    if (resultado.some((r) => !r.error)) {
      festejar();
      void decir(LINEAS.equipoListo);
    }
  }

  async function copiar(texto: string) {
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(texto);
      setTimeout(() => setCopiado(null), 1500);
    } catch {
      /* sin portapapeles: el texto está a la vista */
    }
  }

  return (
    <div className="ob-cols">
      <div className="ob-lcol">
        <Slot />
        <Burbuja />
      </div>
      <div className="ob-rcol">
        <p className="ob-kick">Paso 6 · Equipo · opcional</p>
        <h1>{despachoAdmin || perfil === "despacho" ? "Invita a tu equipo" : "Invita a tu contador"}</h1>
        <p className="ob-sub">
          {despachoAdmin
            ? "Cada persona ve sólo las empresas que le asignes desde Configuración."
            : "Trabaja aquí mismo contigo: ve lo mismo que tú, y yo le explico qué hice."}
        </p>
        <div className="ob-panel" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {filas.map((f, i) => (
            <div key={i} className="ob-inv">
              <input
                className="ob-field"
                type="email"
                placeholder={despachoAdmin ? "correo@tudespacho.mx" : "correo@tucontador.mx"}
                value={f.email}
                onChange={(e) => setFilas((xs) => xs.map((x, k) => (k === i ? { ...x, email: e.target.value } : x)))}
              />
              <select
                className="ob-select"
                aria-label="Rol"
                value={f.rol}
                onChange={(e) => setFilas((xs) => xs.map((x, k) => (k === i ? { ...x, rol: e.target.value } : x)))}
              >
                {roles.map((r) => (
                  <option key={r.role} value={r.role}>
                    {r.label}
                  </option>
                ))}
              </select>
              <button type="button" className="rm" aria-label="Quitar" onClick={() => setFilas((xs) => (xs.length > 1 ? xs.filter((_, k) => k !== i) : xs))}>
                <X size={16} />
              </button>
            </div>
          ))}
          <button type="button" className="ob-btn g" style={{ alignSelf: "flex-start" }} onClick={() => setFilas((xs) => [...xs, { email: "", rol: roles[0].role }])}>
            <Plus size={16} /> Agregar otra persona
          </button>
          {enviados.length > 0 && (
            <div className="ob-sent">
              {enviados.map((e) =>
                e.error ? (
                  <div key={e.email} style={{ background: "var(--red-tint)", color: "var(--red-ink)" }}>
                    {e.email}: {e.error}
                  </div>
                ) : (
                  <div key={e.email}>
                    <Check size={15} strokeWidth={2.5} /> {e.email}
                    {e.tempPassword ? (
                      <>
                        · contraseña temporal <code>{e.tempPassword}</code>
                        <button type="button" aria-label="Copiar" onClick={() => void copiar(`${e.email} / ${e.tempPassword}`)}>
                          {copiado === `${e.email} / ${e.tempPassword}` ? <Check size={14} /> : <Copy size={14} />}
                        </button>
                      </>
                    ) : (
                      " · ya tenía cuenta: entra con la suya"
                    )}
                  </div>
                ),
              )}
              <p className="ob-fine">Todavía no mando correos: compárteles tú sus datos de entrada.</p>
            </div>
          )}
        </div>
        <div className="ob-acts">
          <button type="button" className="ob-btn p" disabled={enviando} onClick={() => void invitar()}>
            {enviando ? "Dando acceso…" : "Dar acceso"}
          </button>
          <button type="button" className="ob-btn g" onClick={onSeguir}>
            {enviados.some((e) => !e.error) ? "Continuar" : "Después"}
          </button>
        </div>
      </div>
    </div>
  );
}
