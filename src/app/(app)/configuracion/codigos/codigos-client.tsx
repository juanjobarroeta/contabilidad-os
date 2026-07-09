"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Loader2, Plus, TicketPercent } from "lucide-react";

// Form + lista de códigos de descuento. Habla con /api/billing/codigos (GET,
// POST, PATCH); toda la lógica de Stripe vive en el servidor.

interface CodigoResumen {
  id: string;
  codigo: string;
  activo: boolean;
  cliente: string;
  descuento: string;
  duracion: string;
  canjes: number;
  maxCanjes: number | null;
  expiraEl: string | null;
  creadoEl: string;
}

const INPUT_CLS =
  "w-full rounded-md border border-cos-line bg-cos-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cos-brand-tint";

function fecha(iso: string): string {
  return new Date(iso).toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" });
}

export function CodigosClient({ configurado }: { configurado: boolean }) {
  const [codigos, setCodigos] = useState<CodigoResumen[] | null>(null);
  const [listaError, setListaError] = useState<string | null>(null);

  // ── Form ──
  const [cliente, setCliente] = useState("");
  const [tipo, setTipo] = useState<"porcentaje" | "monto">("porcentaje");
  const [valor, setValor] = useState("");
  const [duracion, setDuracion] = useState<"siempre" | "una_vez" | "meses">("siempre");
  const [meses, setMeses] = useState("12");
  const [codigoTxt, setCodigoTxt] = useState("");
  const [expiraDias, setExpiraDias] = useState("30");
  const [creando, setCreando] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [creado, setCreado] = useState<CodigoResumen | null>(null);
  const [copiado, setCopiado] = useState(false);
  const [mutando, setMutando] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setListaError(null);
    try {
      const res = await fetch("/api/billing/codigos");
      const data = (await res.json().catch(() => null)) as
        | { codigos?: CodigoResumen[]; error?: string }
        | null;
      if (res.ok && data?.codigos) setCodigos(data.codigos);
      else setListaError(data?.error ?? "No se pudieron cargar los códigos.");
    } catch {
      setListaError("No se pudieron cargar los códigos.");
    }
  }, []);

  useEffect(() => {
    if (configurado) void cargar();
  }, [configurado, cargar]);

  if (!configurado) {
    return (
      <p className="text-sm text-cos-ink-soft">
        Stripe aún no está configurado (STRIPE_SECRET_KEY). Los códigos se crean directamente en
        Stripe, así que este panel se habilita junto con los pagos.
      </p>
    );
  }

  async function crear(e: React.FormEvent) {
    e.preventDefault();
    setCreando(true);
    setFormError(null);
    setCreado(null);
    try {
      const res = await fetch("/api/billing/codigos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cliente: cliente.trim() || undefined,
          tipo,
          valor: Number(valor),
          duracion,
          ...(duracion === "meses" ? { meses: Number(meses) } : {}),
          ...(codigoTxt.trim() ? { codigo: codigoTxt.trim() } : {}),
          expiraDias: Number(expiraDias),
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { codigo?: CodigoResumen; error?: string }
        | null;
      if (res.ok && data?.codigo) {
        setCreado(data.codigo);
        setCopiado(false);
        setCodigoTxt("");
        void cargar();
      } else {
        setFormError(data?.error ?? "No se pudo crear el código.");
      }
    } catch {
      setFormError("No se pudo crear el código.");
    }
    setCreando(false);
  }

  async function alternar(c: CodigoResumen) {
    setMutando(c.id);
    try {
      const res = await fetch("/api/billing/codigos", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: c.id, activo: !c.activo }),
      });
      if (res.ok) await cargar();
    } finally {
      setMutando(null);
    }
  }

  async function copiar(texto: string) {
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2000);
    } catch {
      // sin clipboard (http, permisos): el código queda visible para copiar a mano
    }
  }

  return (
    <div className="space-y-6">
      {/* ── Crear ── */}
      <form onSubmit={crear} className="bg-cos-card border border-cos-line rounded-xl p-5">
        <p className="font-semibold text-sm mb-4 flex items-center gap-2">
          <TicketPercent className="h-4 w-4 text-cos-brand-ink" /> Nuevo código
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium mb-1">Cliente / negociación</label>
            <input
              type="text"
              value={cliente}
              onChange={(e) => setCliente(e.target.value)}
              placeholder="Despacho García — 10 empresas"
              className={INPUT_CLS}
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">
              Código <span className="font-normal text-cos-ink-soft">(vacío = lo genera Stripe)</span>
            </label>
            <input
              type="text"
              value={codigoTxt}
              onChange={(e) => setCodigoTxt(e.target.value.toUpperCase())}
              placeholder="GARCIA-30"
              className={`${INPUT_CLS} font-mono uppercase`}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Descuento</label>
              <select value={tipo} onChange={(e) => setTipo(e.target.value as typeof tipo)} className={INPUT_CLS}>
                <option value="porcentaje">Porcentaje (%)</option>
                <option value="monto">Monto fijo (MXN)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">
                {tipo === "porcentaje" ? "%" : "MXN por cobro"}
              </label>
              <input
                type="number"
                required
                min="0.01"
                max={tipo === "porcentaje" ? 100 : undefined}
                step="0.01"
                value={valor}
                onChange={(e) => setValor(e.target.value)}
                placeholder={tipo === "porcentaje" ? "30" : "400"}
                className={INPUT_CLS}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Aplica</label>
              <select
                value={duracion}
                onChange={(e) => setDuracion(e.target.value as typeof duracion)}
                className={INPUT_CLS}
              >
                <option value="siempre">Siempre (precio permanente)</option>
                <option value="meses">Los primeros N meses</option>
                <option value="una_vez">Sólo el primer cobro</option>
              </select>
            </div>
            {duracion === "meses" ? (
              <div>
                <label className="block text-xs font-medium mb-1">Meses</label>
                <input
                  type="number"
                  required
                  min="1"
                  max="36"
                  value={meses}
                  onChange={(e) => setMeses(e.target.value)}
                  className={INPUT_CLS}
                />
              </div>
            ) : (
              <div>
                <label className="block text-xs font-medium mb-1">
                  Vence en (días) <span className="font-normal text-cos-ink-soft">0 = no vence</span>
                </label>
                <input
                  type="number"
                  min="0"
                  max="365"
                  value={expiraDias}
                  onChange={(e) => setExpiraDias(e.target.value)}
                  className={INPUT_CLS}
                />
              </div>
            )}
          </div>
          {duracion === "meses" && (
            <div>
              <label className="block text-xs font-medium mb-1">
                Vence en (días) <span className="font-normal text-cos-ink-soft">0 = no vence</span>
              </label>
              <input
                type="number"
                min="0"
                max="365"
                value={expiraDias}
                onChange={(e) => setExpiraDias(e.target.value)}
                className={INPUT_CLS}
              />
            </div>
          )}
        </div>

        <p className="text-xs text-cos-ink-faint mt-3">
          El vencimiento es el plazo para <em>canjear</em> el código; una vez canjeado, el descuento
          dura lo que indica «Aplica». Cada código admite un solo canje.
        </p>

        {formError && (
          <p className="text-sm text-red-600 mt-3" role="alert">
            {formError}
          </p>
        )}

        {creado && (
          <div className="mt-4 rounded-md bg-cos-jade-tint border border-cos-jade-ink/20 px-4 py-3 flex flex-wrap items-center gap-3">
            <span className="text-sm text-cos-jade-ink">Código creado:</span>
            <span className="font-mono font-bold text-cos-ink">{creado.codigo}</span>
            <span className="text-xs text-cos-ink-soft">
              {creado.descuento} · {creado.duracion}
              {creado.expiraEl ? ` · canjeable hasta ${fecha(creado.expiraEl)}` : ""}
            </span>
            <button
              type="button"
              onClick={() => copiar(creado.codigo)}
              className="inline-flex items-center gap-1 text-xs font-semibold text-cos-brand-ink hover:underline"
            >
              {copiado ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copiado ? "Copiado" : "Copiar"}
            </button>
          </div>
        )}

        <button
          type="submit"
          disabled={creando}
          className="mt-4 inline-flex items-center gap-2 rounded-md bg-cos-brand text-white text-sm font-semibold px-4 py-2 hover:bg-cos-brand-deep disabled:opacity-50"
        >
          {creando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Crear código
        </button>
      </form>

      {/* ── Lista ── */}
      <div className="bg-cos-card border border-cos-line rounded-xl p-5">
        <p className="font-semibold text-sm mb-3">Códigos emitidos</p>
        {listaError && <p className="text-sm text-red-600">{listaError}</p>}
        {!listaError && codigos === null && (
          <p className="text-sm text-cos-ink-soft flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
          </p>
        )}
        {codigos !== null && codigos.length === 0 && (
          <p className="text-sm text-cos-ink-soft">Aún no has creado códigos.</p>
        )}
        {codigos !== null && codigos.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-cos-ink-soft border-b border-cos-line">
                  <th className="py-2 pr-3 font-medium">Código</th>
                  <th className="py-2 pr-3 font-medium">Cliente</th>
                  <th className="py-2 pr-3 font-medium">Descuento</th>
                  <th className="py-2 pr-3 font-medium">Canjes</th>
                  <th className="py-2 pr-3 font-medium">Vence</th>
                  <th className="py-2 pr-3 font-medium">Estado</th>
                  <th className="py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {codigos.map((c) => (
                  <tr key={c.id} className="border-b border-cos-line/60 last:border-0">
                    <td className="py-2 pr-3 font-mono font-semibold">{c.codigo}</td>
                    <td className="py-2 pr-3 max-w-[180px] truncate" title={c.cliente}>
                      {c.cliente || "—"}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {c.descuento} · {c.duracion}
                    </td>
                    <td className="py-2 pr-3">
                      {c.canjes}
                      {c.maxCanjes !== null ? ` / ${c.maxCanjes}` : ""}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">{c.expiraEl ? fecha(c.expiraEl) : "—"}</td>
                    <td className="py-2 pr-3">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                          c.activo ? "bg-cos-jade-tint text-cos-jade-ink" : "bg-cos-paper text-cos-ink-soft"
                        }`}
                      >
                        {c.activo ? "Activo" : "Inactivo"}
                      </span>
                    </td>
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        onClick={() => alternar(c)}
                        disabled={mutando === c.id}
                        className="text-xs font-medium text-cos-ink-soft hover:text-cos-brand-ink disabled:opacity-50"
                      >
                        {mutando === c.id ? "…" : c.activo ? "Desactivar" : "Reactivar"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-cos-ink-faint mt-3">
          Desactivar un código impide canjearlo; no afecta las suscripciones que ya lo aplicaron.
        </p>
      </div>
    </div>
  );
}
