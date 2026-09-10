"use client";

// ─────────────────────────────────────────────────────────────────────────────
// GESTIÓN DE BANCOS — el cuerpo del viejo /bancos (1,798 líneas), movido aquí
// TAL CUAL para que la página se convierta en tabs con la mesa de conciliación
// al frente. Regla del trasplante: el JSX se MUEVE, no se rediseña.
//
// `vista` gatea qué secciones se pintan:
//   · "cuentas"     — selector de cuentas, tarjeta con saldo/importar/auto,
//                     resumen de importación y lotes recientes (deshacer).
//   · "movimientos" — filtros, lista con búsqueda de coincidencias, similares,
//                     selección en lote. El triage fino, uno por uno.
//   · "historico"   — la misma lista fijada en Conciliados: qué se casó con
//                     qué, con Desconciliar a la mano.
//
// POR QUÉ UNA PROP Y NO TRES COMPONENTES. Los 50+ useState de este closure se
// cruzan (importar refresca movimientos, conciliar refresca cuentas, el toast
// es común). Partirlos en tres closures exigía subir estado al shell — cirugía
// grande sin poder observar la app corriendo. La prop entrega la misma UI con
// riesgo cero; la separación real puede venir después, con la app a la vista.
// ─────────────────────────────────────────────────────────────────────────────

import { Fragment, useEffect, useState, useCallback, useRef } from "react";
import {
  Landmark, Upload, Sparkles, Loader2, Link2, Search, CheckCircle2,
  AlertTriangle, ChevronDown, Plus, CheckSquare, X, Building2,
    ArrowLeftRight, SlidersHorizontal, Pencil, Trash2,
} from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { RepresentacionImpresa } from "@/components/facturas/RepresentacionImpresa";
import { Card, Money, Chip } from "@/components/ui";
import { Alert, RetryButton } from "@/components/ui/feedback";
import { etiquetaImpuesto } from "@/lib/conciliacion-impuestos";
import { ResolverMovimiento, type RepSugerido } from "./ResolverMovimiento";
import { AvisoRepSugerido } from "./AvisoRepSugerido";
import { AccionesEnLote } from "./AccionesEnLote";
import { fmtFechaCorta } from "./resolver-tipos";

// ── Types (mirror /api/bancos) ────────────────────────────────────────────────
interface BankAccount {
  id: string; banco: string; nombre: string; numeroCuenta: string; clabe?: string;
  titular?: string | null; moneda: string;
  stats: { total: number; unmatched: number; matched: number; ignored: number };
  lastTransaction: { fecha: string; saldo?: number } | null;
  /** Último estado de cuenta cargado con saldo final: el ancla que firma el banco. */
  estadoCuenta: {
    periodo: string | null;
    saldoFinal: number;
    cuadro: boolean | null;
    subidoEl: string;
    archivo: string | null;
  } | null;
}
interface BankTx {
  id: string;
  bankAccountId: string; fecha: string; descripcion: string; monto: number; referencia?: string; saldo?: number;
  tipo: "CREDITO" | "DEBITO"; status: "UNMATCHED" | "MATCHED" | "IGNORED";
  notes?: string | null;
  // Contraparte desglosada de la descripción (bancos/spei-descripcion.ts).
  // El banco ya las escribía etiquetadas dentro de `descripcion`.
  contraparteNombre?: string | null;
  contraparteRfc?: string | null;
  contraparteClabe?: string | null;
  contraparteBanco?: string | null;
  conceptoPago?: string | null;
  claveRastreo?: string | null;
  lineaCaptura?: string | null;
  invoiceId?: string | null;
  invoice?: {
    id: string;
    uuid?: string | null;
    folio?: string | null;
    serie?: string | null;
    total: number; contraparteNombre?: string | null;
    fecha?: string | null;
    customer?: { razonSocial: string } | null;
  } | null;
  /** Comisión por transferencia: de qué envío viene este cobro. */
  comisionDe?: { id: string; fecha: string; monto: number; contraparteNombre?: string | null; descripcion: string } | null;
  /** Cobros de comisión que generó esta transferencia. */
  comisiones?: { id: string; monto: number; descripcion: string }[];
  /** Devolución bancaria: este movimiento ES la devolución de aquel pago. */
  devolucionDe?: { id: string; fecha: string; descripcion: string; monto: number } | null;
  /** Devolución bancaria: este pago FUE devuelto por aquel movimiento. */
  devolucionPor?: { id: string; fecha: string; descripcion: string; monto: number } | null;
  /** Sugerencia del servidor: probable pago original de esta devolución. */
  sugerenciaDevolucion?: { origenId: string; descripcion: string; fecha: string; monto: number } | null;
  // Pago de impuestos conciliado (SIPARE / línea de captura).
  taxDeclaration?: { id: string; tipo: string; periodo: string; status: string } | null;
  // Conciliación uno-a-varios: porciones asignadas a varias facturas.
  conciliacionDetalles?: {
    id: string; montoAsignado: number;
    invoice: { id: string; uuid?: string | null; folio?: string | null; serie?: string | null; total: number; contraparteNombre?: string | null; customer?: { razonSocial: string } | null };
  }[];
}

interface Counts {
  UNMATCHED?: number; MATCHED?: number; IGNORED?: number; total?: number;
  PENDING?: number; TAX_PAYMENT?: number; PAYROLL_NO_CFDI?: number;
  LOAN_RECEIVED?: number; LOAN_GIVEN?: number; CAPITAL_CONTRIBUTION?: number;
  NON_DEDUCTIBLE?: number; INTERNAL_TRANSFER?: number;
}

// Filtro = estado base o sub-categoría por tag (la API entiende ambos en ?status=).
type Filter =
  | "all" | "UNMATCHED" | "MATCHED" | "IGNORED"
  | "PENDING" | "TAX_PAYMENT" | "PAYROLL_NO_CFDI" | "LOAN_RECEIVED"
  | "LOAN_GIVEN" | "CAPITAL_CONTRIBUTION" | "NON_DEDUCTIBLE" | "INTERNAL_TRANSFER"
  | "RENT" | "FINANCIAL_INCOME" | "IVA_COMISION" | "PAYROLL_DISPERSED" | "ANTICIPO_CLIENTE" | "ANTICIPO_PROVEEDOR";

// Categorías "sin factura" → tag de notes que persiste (PATCH ignore). null = ignorar simple.
/** Movimientos por página. La lista crece con «Cargar más». */
const PAGE_SIZE = 80;

// tag → etiqueta corta para el chip de estado en un movimiento ya categorizado.
const TAG_LABEL: Record<string, string> = {
  TAX_PAYMENT: "Impuestos", PENDING_MONTHLY_CFDI: "Pendiente CFDI",
  PAYROLL_NO_CFDI: "Nómina", LOAN_RECEIVED: "Préstamo", LOAN_GIVEN: "Préstamo otorgado",
  RENT: "Renta", FINANCIAL_INCOME: "Intereses", IVA_COMISION: "IVA comisión",
  PAYROLL_DISPERSED: "Dispersión nómina",
  ANTICIPO_CLIENTE: "Anticipo · falta CFDI", ANTICIPO_PROVEEDOR: "Anticipo a proveedor · falta CFDI",
  CAPITAL_CONTRIBUTION: "Capital", NON_DEDUCTIBLE: "No deducible", INTERNAL_TRANSFER: "Transferencia",
};
// Chips de "Más filtros": tag de filtro → etiqueta + clave de conteo.
const TIPO_CHIPS: { f: Filter; t: string; k: keyof Counts }[] = [
  { f: "PENDING", t: "Pendiente CFDI", k: "PENDING" },
  { f: "TAX_PAYMENT", t: "Impuestos", k: "TAX_PAYMENT" },
  { f: "PAYROLL_NO_CFDI", t: "Nómina sin CFDI", k: "PAYROLL_NO_CFDI" },
  { f: "LOAN_RECEIVED", t: "Préstamos", k: "LOAN_RECEIVED" },
  { f: "LOAN_GIVEN", t: "Préstamos otorgados", k: "LOAN_GIVEN" },
  { f: "CAPITAL_CONTRIBUTION", t: "Capital", k: "CAPITAL_CONTRIBUTION" },
  { f: "INTERNAL_TRANSFER", t: "Transferencias", k: "INTERNAL_TRANSFER" },
  { f: "NON_DEDUCTIBLE", t: "No deducible", k: "NON_DEDUCTIBLE" },
  { f: "IGNORED", t: "Ignorados", k: "IGNORED" },
];

const BANKS = ["BBVA","Banamex","Santander","Banorte","HSBC","Scotiabank","Afirme","Inbursa","BanBajío","Otro"];
const LBL = "block text-[12.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint";
/** "2026-08" → "agosto 2026" (para el selector y los separadores por mes). */
const fmtMes = (ym: string) => {
  const M = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
  const [y, m] = ym.split("-").map(Number);
  return `${M[(m ?? 1) - 1]} ${y}`;
};
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export type VistaBancos = "cuentas" | "movimientos" | "historico";

export function GestionBancos({ vista }: { vista: VistaBancos }) {
  const { activeCompany } = useCompany();
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [txs, setTxs] = useState<BankTx[]>([]);
  const [counts, setCounts] = useState<Counts>({});
  const [filter, setFilter] = useState<Filter>(vista === "historico" ? "MATCHED" : "all");
  // División por mes: "" = todos (con separadores por mes en la lista);
  // "YYYY-MM" acota movimientos Y conteos a ese mes (el backend ya lo soporta).
  const [mes, setMes] = useState("");
  const [meses, setMeses] = useState<{ mes: string; count: number }[]>([]);
  // Paginación de la lista: se carga de a poco y se puede seguir hacia atrás.
  const [pagina, setPagina] = useState(1);
  const [paginas, setPaginas] = useState(1);
  const [cargandoMas, setCargandoMas] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [loading, setLoading] = useState(false);
  // «Ver factura» abre la representación impresa AQUÍ (modal) — antes mandaba
  // a /facturas?q=<uuid>, una búsqueda que te saca del flujo (pedido del owner).
  const [verFacturaId, setVerFacturaId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"" | "auto" | "upload">("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  // Sugerencia post-conciliación: el abono que acabas de conciliar paga una
  // factura PPD → ofrecer emitir su complemento de pago (REP) de un toque con
  // el monto y la fecha del propio movimiento.
  const [repSugerido, setRepSugerido] = useState<RepSugerido | null>(null);
  // Modo selección + lote
  const [selectMode, setSelectMode] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // Modal de cuenta: null=cerrado · {account:null}=agregar · {account:X}=editar
  const [accountModal, setAccountModal] = useState<{ account: BankAccount | null } | null>(null);
  // Resumen de la última importación cuando hubo filas descartadas o posibles
  // duplicados: el CSV del banco es la fuente de verdad, así que nada se
  // omite en silencio — se muestra qué se descartó y por qué.
  const [importReport, setImportReport] = useState<{
    imported: number;
    posiblesDuplicados: number;
    descartadas: { fila: number; motivo: string }[];
  } | null>(null);
  // Historial de lotes importados (con su PDF de evidencia cuando lo hay).
  const [lotes, setLotes] = useState<{
    id: string; createdAt: string; banco: string | null; periodo: string | null;
    count: number; cuentaEtiqueta: string; tienePdf: boolean; cuadro: boolean | null;
    borrables: number; conciliados: number;
  }[]>([]);
  const [deshaciendo, setDeshaciendo] = useState<string | null>(null);

  // Fallos de carga. Sin esto, un fetch caído se leía como "Sin cuentas
  // bancarias" / "No hay movimientos" — afirmar que los datos no existen es
  // peor que admitir que no se pudieron traer.
  const [errorCuentas, setErrorCuentas] = useState("");
  const [errorTxs, setErrorTxs] = useState("");

  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(""), 2800); };
  // Contraseña de PDFs protegidos, recordada durante la sesión de carga (los 12
  // estados de un año suelen compartirla). Nunca se persiste.
  const pdfPassRef = useRef("");

  const loadAccounts = useCallback(async () => {
    if (!activeCompany) return;
    setErrorCuentas("");
    try {
      const res = await fetch(`/api/bancos?companyId=${activeCompany.id}`);
      const data = await res.json();
      // Una respuesta de error no es una lista vacía: sin array real esto es
      // un fallo de carga, no "sin cuentas".
      if (!res.ok || !Array.isArray(data)) throw new Error();
      const list: BankAccount[] = data;
      setAccounts(list);
      setSelectedId((prev) =>
        prev === "todas"
          ? prev
          : prev && list.some((a) => a.id === prev)
            ? prev
            : list.length > 1
              ? "todas"
              : list[0]?.id ?? null,
      );
    } catch {
      setErrorCuentas("No se pudieron cargar las cuentas bancarias. Revisa tu conexión e inténtalo de nuevo.");
    }
  }, [activeCompany]);

  const loadTxs = useCallback(async () => {
    if (!selectedId) { setTxs([]); return; }
    setLoading(true); setExpandedId(null);
    setErrorTxs("");
    try {
      const res = await fetch(`/api/bancos/${selectedId}?status=${filter}&page=1&pageSize=${PAGE_SIZE}${mes ? `&mes=${mes}` : ""}${selectedId === "todas" && activeCompany ? `&companyId=${activeCompany.id}` : ""}`);
      const data = await res.json();
      // Un error del API no es "no hay movimientos": sin array real, es fallo.
      if (!res.ok || !Array.isArray(data?.transactions)) throw new Error();
      setTxs(data.transactions);
      setCounts(data.statusCounts ?? {});
      setMeses(Array.isArray(data.meses) ? data.meses : []);
      // La lista traía sólo la primera página y NUNCA ofrecía la siguiente: con
      // más movimientos que el tamaño de página, los meses viejos simplemente
      // no existían para quien mira. El API ya devolvía `pagination`.
      setPagina(1);
      setPaginas(data.pagination?.pages ?? 1);
    } catch {
      setErrorTxs("No se pudieron cargar los movimientos. Revisa tu conexión e inténtalo de nuevo.");
      setTxs([]);
    } finally { setLoading(false); }
  }, [selectedId, filter, mes]);

  /** Trae la página siguiente y la AGREGA (no reemplaza): la lista crece. */
  const cargarMas = useCallback(async () => {
    if (!selectedId || cargandoMas || pagina >= paginas) return;
    setCargandoMas(true);
    try {
      const sig = pagina + 1;
      const res = await fetch(`/api/bancos/${selectedId}?status=${filter}&page=${sig}&pageSize=${PAGE_SIZE}${mes ? `&mes=${mes}` : ""}${selectedId === "todas" && activeCompany ? `&companyId=${activeCompany.id}` : ""}`);
      const data = await res.json();
      setTxs((prev) => [...prev, ...(data.transactions ?? [])]);
      setPagina(sig);
    } finally { setCargandoMas(false); }
  }, [selectedId, filter, mes, pagina, paginas, cargandoMas]);

  /** Deshace un lote: borra sus movimientos SIN conciliar y conserva los que ya
   *  se casaron con un CFDI — deshacer nunca destruye trabajo fiscal hecho. */
  async function deshacerLote(lote: (typeof lotes)[number]) {
    if (!activeCompany) return;
    if (lote.borrables === 0) {
      showToast("Este lote ya no tiene movimientos por borrar (todos están conciliados).");
      return;
    }
    const aviso =
      `Se borrarán ${lote.borrables} movimiento(s) sin conciliar de esta importación` +
      (lote.conciliados > 0
        ? `.\n\n${lote.conciliados} ya conciliado(s) con factura se CONSERVAN.`
        : ".") +
      "\n\n¿Continuar?";
    if (!confirm(aviso)) return;
    setDeshaciendo(lote.id);
    try {
      const res = await fetch(`/api/bancos/import-batches/${lote.id}/undo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: activeCompany.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data?.error ?? "No se pudo deshacer la importación");
        return;
      }
      showToast(
        `✓ ${data.borrados} movimiento(s) borrados` +
          (data.conservados > 0 ? ` · ${data.conservados} conservados por estar conciliados` : "")
      );
      await Promise.all([loadTxs(), loadAccounts(), loadLotes()]);
    } finally {
      setDeshaciendo(null);
    }
  }

  const loadLotes = useCallback(async () => {
    if (!activeCompany) { setLotes([]); return; }
    try {
      const res = await fetch(`/api/bancos/import-batches?companyId=${activeCompany.id}`);
      const data = await res.json();
      setLotes(Array.isArray(data) ? data : []);
    } catch { setLotes([]); }
  }, [activeCompany]);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);
  useEffect(() => { loadTxs(); }, [loadTxs]);
  useEffect(() => { loadLotes(); }, [loadLotes]);
  // Salir del modo selección al cambiar de cuenta/filtro/mes.
  useEffect(() => { setPicked(new Set()); }, [selectedId, filter, mes]);
  // Al cambiar de cuenta, el mes elegido puede no existir en la otra — reset.
  useEffect(() => { setMes(""); }, [selectedId]);

  const account = accounts.find((a) => a.id === selectedId) ?? null;

  async function autoReconcile() {
    if (!selectedId) return;
    setBusy("auto");
    try {
      const res = await fetch(`/api/bancos/${selectedId}/match`, { method: "POST" });
      const data = await res.json();
      const n = data.autoMatched ?? 0;
      showToast(n > 0 ? `${n} movimiento${n === 1 ? "" : "s"} conciliado${n === 1 ? "" : "s"} automáticamente` : "Sin coincidencias automáticas de alta confianza");
      await Promise.all([loadTxs(), loadAccounts()]);
    } finally { setBusy(""); }
  }

  /** PDF/imagen del estado de cuenta → extracción con IA (upload-pdf). Si los
   *  saldos no cuadran, el servidor NO importa y pedimos confirmación (force).
   *  PDFs con contraseña (Banamex, Santander…): el servidor responde 422
   *  needsPassword, aquí se pide y se reintenta. La contraseña buena se
   *  recuerda para el resto de la bolsa (12 estados = 1 sola pregunta). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function subirPdf(file: File): Promise<any> {
    let password = pdfPassRef.current;
    const enviar = async (qs: string) => {
      const form = new FormData();
      form.append("file", file);
      if (password) form.append("password", password);
      const res = await fetch(`/api/bancos/${selectedId}/upload-pdf${qs}`, { method: "POST", body: form });
      return { res, data: await res.json() };
    };

    for (let intento = 0; intento < 4; intento++) {
      // eslint-disable-next-line prefer-const
      let { res, data } = await enviar("");
      if (res.status === 422 && data?.needsPassword) {
        const entered = prompt(`${file.name}\n\n${data.error ?? "Este PDF requiere contraseña."}`);
        if (entered == null || entered === "") {
          return { ok: false, message: "PDF con contraseña — no se ingresó, se omitió el archivo" };
        }
        password = entered;
        continue;
      }
      pdfPassRef.current = password; // funcionó (o no hizo falta): recordar para la bolsa
      if (res.ok && data?.needsReview) {
        const n = data?.extraction?.transactions?.length ?? 0;
        // El servidor YA calculó por qué no cuadra, y con números: «El banco
        // declara 126 retiros y se extrajeron 119: faltan 7». Aquí había un
        // texto fijo que hablaba de «saldos» y de «posible página faltante»
        // aunque el problema fuera otro — el diagnóstico exacto se calculaba y
        // se tiraba, y el usuario decidía a ciegas si importar.
        const motivos: string[] = Array.isArray(data?.extraction?.warnings)
          ? data.extraction.warnings
          : [];
        const detalle = motivos.length > 0
          ? motivos.map((m: string) => `• ${m}`).join("\n")
          : "Los saldos del estado no cuadran con la suma de los movimientos.";
        if (
          n > 0 &&
          confirm(
            `${file.name}\n\nSe extrajeron ${n} movimientos, pero la revisión no cuadra:\n\n${detalle}\n\n` +
            `Importar de todos modos deja el periodo con esas diferencias. ¿Continuar?`
          )
        ) {
          ({ data } = await enviar("?force=1"));
        }
      }
      return data;
    }
    return { ok: false, message: "PDF con contraseña — demasiados intentos" };
  }

  /** Un solo archivo (CSV/Excel o PDF/imagen) → su resultado de importación. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function importarArchivo(file: File): Promise<any> {
    if (/\.(pdf|jpe?g|png)$/i.test(file.name)) return subirPdf(file);
    // SIEMPRE base64, también para CSV: `file.text()` decodifica UTF-8 a fuerza
    // y los bancos mexicanos exportan en Windows-1252, así que "Comisión" se
    // volvía "Comisi<?>n" AQUÍ, en el navegador, sin vuelta atrás. Mandando los
    // bytes, el servidor detecta la codificación real y el formato por FIRMA
    // (la extensión miente: los .xls de BBVA son XML).
    const fileContent = await fileToBase64(file);
    const res = await fetch(`/api/bancos/${selectedId}/upload`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileContent, filename: file.name, encoding: "base64" }),
    });
    return res.json();
  }

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    if (files.length === 0 || !selectedId) return;
    setBusy("upload");
    try {
      // EN BOLSA: un año de estados de cuenta se suelta completo (12 PDFs) y
      // se procesa en secuencia — cada PDF es una extracción con IA, y el
      // orden hace legible el progreso. El resumen acumula todos los archivos.
      let imported = 0;
      let posiblesDuplicados = 0;
      const descartadas: { fila: number; motivo: string }[] = [];
      const errores: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (files.length > 1) showToast(`Procesando ${i + 1}/${files.length}: ${file.name}…`);
        try {
          const data = await importarArchivo(file);
          if (data?.ok) {
            imported += data.imported ?? 0;
            posiblesDuplicados += data.posiblesDuplicados ?? 0;
            descartadas.push(...(data.descartadas ?? []));
          } else {
            errores.push(`${file.name}: ${data?.message ?? data?.error ?? "no se pudo importar"}`);
          }
        } catch {
          errores.push(`${file.name}: error inesperado`);
        }
      }
      showToast(
        files.length === 1 && errores.length === 1
          ? errores[0]
          : `✓ ${imported} movimiento(s) importados de ${files.length} archivo(s)` +
            (posiblesDuplicados > 0 ? ` · ${posiblesDuplicados} omitidos por duplicados` : "") +
            (errores.length > 0 ? ` · ${errores.length} archivo(s) con problema: ${errores.join("; ")}` : "")
      );
      setImportReport(
        descartadas.length > 0 || posiblesDuplicados > 0
          ? { imported, posiblesDuplicados, descartadas }
          : null
      );
      await Promise.all([loadTxs(), loadAccounts(), loadLotes()]);
    } finally { setBusy(""); e.target.value = ""; }
  }

  /** Abre o cierra el panel del movimiento. La carga de candidatos, CEP y
   *  búsqueda manual vive en `ResolverMovimiento`, que se monta al abrir. */
  function expand(tx: BankTx) {
    setExpandedId((actual) => (actual === tx.id ? null : tx.id));
  }

  async function desconciliar(txId: string) {
    setActing(txId);
    try {
      const res = await fetch(`/api/bancos/transactions/${txId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "unmatch" }),
      });
      if (res.ok) { showToast("Movimiento desconciliado"); await Promise.all([loadTxs(), loadAccounts()]); }
      else showToast("No se pudo desconciliar");
    } finally { setActing(null); }
  }

  // Devolución bancaria: vincular la devolución con su pago original (deshace
  // la conciliación del original en el servidor) y desvincular el par.
  async function vincularDevolucion(devolucionId: string, origenId: string) {
    setActing(devolucionId);
    try {
      const res = await fetch(`/api/bancos/transactions/${devolucionId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "vincular-devolucion", origenId }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (res.ok) { showToast("Devolución vinculada — ambos movimientos se netean"); await Promise.all([loadTxs(), loadAccounts()]); }
      else showToast(data?.error ?? "No se pudo vincular la devolución");
    } finally { setActing(null); }
  }

  async function desvincularDevolucion(txId: string) {
    setActing(txId);
    try {
      const res = await fetch(`/api/bancos/transactions/${txId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "desvincular-devolucion" }),
      });
      if (res.ok) { showToast("Par de devolución desvinculado"); await Promise.all([loadTxs(), loadAccounts()]); }
      else showToast("No se pudo desvincular");
    } finally { setActing(null); }
  }

  async function reabrir(txId: string) {
    setActing(txId);
    try {
      const res = await fetch(`/api/bancos/transactions/${txId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "unignore" }),
      });
      if (res.ok) { showToast("Movimiento reabierto"); await Promise.all([loadTxs(), loadAccounts()]); }
    } finally { setActing(null); }
  }

  async function eliminarCuenta(acc: BankAccount) {
    if (!window.confirm(`¿Eliminar la cuenta ${acc.banco} ••${acc.numeroCuenta.slice(-4)}? También se borrarán sus movimientos.`)) return;
    const res = await fetch(`/api/bancos/${acc.id}`, { method: "DELETE" });
    if (res.ok) { showToast("Cuenta eliminada"); setSelectedId(null); await loadAccounts(); }
    else showToast("No se pudo eliminar la cuenta");
  }

  // ── Selección en lote ──────────────────────────────────────────────────────
  function togglePick(id: string) {
    setPicked((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  const pickedIds = [...picked];
  // Neto firmado (un reembolso resta) — coincide con el motor de conciliación.
  const pickedSum = Math.abs(txs.filter((t) => picked.has(t.id)).reduce((s, t) => s + t.monto, 0));
  // Cuántos de los palomeados ya están cruzados: categorizarlos rompe el
  // vínculo, y la barra lo advierte antes de hacerlo.
  const pickedConciliados = txs.filter((t) => picked.has(t.id) && t.status !== "UNMATCHED").length;


  function statusChip(tx: BankTx) {
    if (tx.status === "MATCHED") return <Chip status="conciliado" label="Conciliado" icon={<CheckCircle2 className="h-3 w-3" />} />;
    // Par de devolución vinculado: se distingue del "Ignorado" suelto — estos
    // dos movimientos se netean y la historia del rebote queda conservada.
    if (tx.devolucionDe || tx.devolucionPor) {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-cos-amber-tint px-2.5 py-1 text-[12px] font-semibold text-cos-amber-ink">
          <ArrowLeftRight className="h-3 w-3" /> {tx.devolucionDe ? "Devolución" : "Pago devuelto"}
        </span>
      );
    }
    if (tx.status === "IGNORED") {
      const lbl = tx.notes && TAG_LABEL[tx.notes] ? TAG_LABEL[tx.notes] : "Ignorado";
      return <span className="inline-flex items-center gap-1.5 rounded-full bg-cos-slate-tint px-2.5 py-1 text-[12px] font-semibold text-cos-ink-soft">{lbl}</span>;
    }
    return <Chip status="sin_conciliar" label="Sin conciliar" icon={<AlertTriangle className="h-3 w-3" />} />;
  }

  if (!activeCompany) return <div className="p-8 text-sm text-cos-ink-faint">Selecciona una empresa.</div>;

  return (
    <div>
      {errorCuentas && accounts.length === 0 ? (
        /* Rama de ERROR, excluyente del vacío: si el fetch cayó no se afirma
           "Sin cuentas bancarias" — las cuentas pueden existir. */
        <div className="mt-5">
          <Alert tone="danger" action={<RetryButton onClick={loadAccounts} />}>{errorCuentas}</Alert>
        </div>
      ) : accounts.length === 0 ? (
        <Card className="mt-5 rounded-card border-cos-line p-10 text-center shadow-card">
          <Landmark className="mx-auto mb-3 h-10 w-10 text-cos-ink-faint opacity-40" />
          <p className="text-sm font-medium text-cos-ink">Sin cuentas bancarias</p>
          <button onClick={() => setAccountModal({ account: null })} className="mt-2 inline-block text-[13px] font-semibold text-cos-brand-ink hover:underline">Agregar una cuenta →</button>
        </Card>
      ) : (
        <>
          {/* account selector */}
          <div className="mt-4 flex flex-wrap gap-2">
            {accounts.length > 1 && (
              <button
                onClick={() => { setSelectedId("todas"); setImportReport(null); }}
                className={"inline-flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-[13.5px] font-medium " + ("todas" === selectedId ? "border-cos-brand bg-cos-brand text-white" : "border-cos-line bg-cos-card text-cos-ink-soft hover:border-cos-brand hover:text-cos-brand-ink")}
              >
                Todas las cuentas
              </button>
            )}
            {accounts.map((a) => (
              <button key={a.id} onClick={() => { setSelectedId(a.id); setImportReport(null); }}
                className={"inline-flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-[13.5px] font-medium " + (a.id === selectedId ? "border-cos-brand bg-cos-brand text-white" : "border-cos-line bg-cos-card text-cos-ink-soft hover:border-cos-brand hover:text-cos-brand-ink")}>
                {a.banco} <span className="font-mono text-[12px] opacity-80">••{a.numeroCuenta.slice(-4)}</span>
              </button>
            ))}
            <button onClick={() => setAccountModal({ account: null })} className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-cos-line bg-cos-card px-3.5 py-2 text-[13.5px] font-medium text-cos-brand-ink hover:bg-cos-brand-tint">
              <Plus className="h-3.5 w-3.5" /> Agregar
            </button>
          </div>

          {/* account card */}
          {vista === "cuentas" && !account && selectedId === "todas" && (
            <Card className="mt-4 rounded-card border-cos-line p-5 text-[13.5px] text-cos-ink-soft shadow-card">
              Elige una cuenta arriba para ver su saldo, cargar su estado de cuenta o conciliarla automáticamente.
            </Card>
          )}
          {vista === "cuentas" && account && (
            <Card className="mt-4 rounded-card border-cos-line p-5 shadow-card">
              <div className="flex items-center gap-3.5">
                <div className="grid h-[42px] w-[42px] flex-none place-items-center rounded-[12px] bg-cos-brand-tint text-cos-brand-ink"><Landmark className="h-[22px] w-[22px]" /></div>
                <div className="min-w-0 flex-1">
                  <p className="text-[16px] font-semibold text-cos-ink">{account.banco}</p>
                  <p className="truncate text-[13px] text-cos-ink-soft">{account.titular ?? account.nombre} · <span className="font-mono">••••{account.numeroCuenta.slice(-4)}</span></p>
                </div>
                <div className="flex flex-none items-center gap-1.5">
                  {account.stats.unmatched > 0
                    ? <Chip status="sin_conciliar" label={`${account.stats.unmatched} por conciliar`} />
                    : <Chip status="conciliado" label="Todo cuadrado" />}
                  <button onClick={() => setAccountModal({ account })} title="Editar cuenta"
                    className="grid h-8 w-8 place-items-center rounded-control text-cos-ink-faint hover:bg-cos-paper hover:text-cos-ink"><Pencil className="h-[15px] w-[15px]" /></button>
                  <button onClick={() => eliminarCuenta(account)} title="Eliminar cuenta"
                    className="grid h-8 w-8 place-items-center rounded-control text-cos-ink-faint hover:bg-cos-red-tint hover:text-cos-red-ink"><Trash2 className="h-[15px] w-[15px]" /></button>
                </div>
              </div>
              <div className="my-[18px] flex flex-col gap-1.5 border-y border-cos-line-soft py-4">
                <span className={LBL}>Saldo en banco</span>
                {account.lastTransaction?.saldo != null
                  ? <Money value={account.lastTransaction.saldo} size={30} weight={700} />
                  : (
                    <>
                      <span className="font-mono text-[20px] text-cos-ink-faint">—</span>
                      <span className="text-[12px] text-cos-ink-faint">Se toma del estado de cuenta que cargues.</span>
                    </>
                  )}
                {/* El saldo que FIRMA el banco en su estado, con el veredicto
                    del cotejo: es contra este número que se mide la cuenta. */}
                {account.estadoCuenta && (
                  <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-cos-ink-soft">
                    Según tu estado de cuenta
                    {account.estadoCuenta.periodo ? ` (${account.estadoCuenta.periodo})` : ""}:
                    <Money value={account.estadoCuenta.saldoFinal} size={12} weight={600} />
                    {account.estadoCuenta.cuadro === false && (
                      <span className="rounded-full bg-cos-amber-tint px-1.5 py-0.5 text-[11px] font-medium text-cos-amber-ink">
                        la última carga no cuadró
                      </span>
                    )}
                    {account.estadoCuenta.cuadro === true && (
                      <span className="rounded-full bg-cos-jade-tint px-1.5 py-0.5 text-[11px] font-medium text-cos-jade-ink">
                        cuadrado
                      </span>
                    )}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-2.5">
                <label className={"flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-control border border-cos-line bg-cos-card px-4 py-2.5 text-[14px] font-semibold text-cos-ink hover:bg-cos-paper " + (busy ? "pointer-events-none opacity-50" : "")}>
                  {busy === "upload" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Cargar estado de cuenta
                  <input type="file" multiple accept=".csv,.txt,.ofx,.xlsx,.xls,.xlsm,.pdf,application/pdf,.jpg,.jpeg,.png" className="hidden" onChange={onUpload} disabled={!!busy} />
                </label>
                <button onClick={autoReconcile} disabled={!!busy}
                  className="flex flex-1 items-center justify-center gap-2 rounded-control bg-cos-brand px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50">
                  {busy === "auto" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Conciliar automáticamente
                </button>
              </div>
            </Card>
          )}

          {/* Resumen de importación: filas descartadas y posibles duplicados.
              El estado de cuenta es la fuente de verdad — nunca se omite nada
              en silencio, aquí se explica cada fila que no entró. */}
          {vista === "cuentas" && importReport && (
            <div className="mt-4 rounded-card border border-cos-amber-ink/20 bg-cos-amber-tint p-4 text-[13.5px] text-cos-amber-ink">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">
                    Se importaron {importReport.imported} movimiento{importReport.imported === 1 ? "" : "s"}.
                    {importReport.descartadas.length > 0 && (
                      <> {importReport.descartadas.length} fila{importReport.descartadas.length === 1 ? " se descartó" : "s se descartaron"} (ver detalle).</>
                    )}
                    {importReport.posiblesDuplicados > 0 && (
                      <> {importReport.posiblesDuplicados} se omit{importReport.posiblesDuplicados === 1 ? "ió" : "ieron"} por parecer duplicado{importReport.posiblesDuplicados === 1 ? "" : "s"} de movimientos ya existentes.</>
                    )}
                  </p>
                  {importReport.descartadas.length > 0 && (
                    <details className="mt-1.5">
                      <summary className="cursor-pointer font-medium underline decoration-dotted underline-offset-2">
                        Ver detalle de las filas descartadas
                      </summary>
                      <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto font-mono text-[12.5px]">
                        {importReport.descartadas.map((d, i) => (
                          <li key={i}>Fila {d.fila}: {d.motivo}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {importReport.posiblesDuplicados > 0 && (
                    <p className="mt-1.5 text-[12.5px] opacity-80">
                      Si vuelves a subir el mismo archivo, los movimientos que ya estaban registrados se omiten para no duplicarlos.
                    </p>
                  )}
                </div>
                <button onClick={() => setImportReport(null)} title="Cerrar aviso"
                  className="grid h-7 w-7 flex-none place-items-center rounded-control hover:bg-cos-amber-ink/10">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          {/* Importaciones recientes: cada lote con su cuadre y, cuando la
              importación fue por visión (PDF/imagen), el documento original
              descargable — evidencia de dónde salió cada movimiento. */}
          {vista === "cuentas" && lotes.length > 0 && (
            <details className="mt-4 rounded-card border border-cos-line bg-cos-card shadow-card">
              <summary className="cursor-pointer select-none px-5 py-3.5 text-[14px] font-semibold text-cos-ink">
                Importaciones recientes <span className="font-mono text-[12.5px] font-normal text-cos-ink-faint">({lotes.length})</span>
              </summary>
              <div className="overflow-x-auto border-t border-cos-line-soft">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="text-left text-[12px] uppercase tracking-wide text-cos-ink-faint">
                      <th className="px-5 py-2 font-medium">Fecha</th>
                      <th className="px-3 py-2 font-medium">Cuenta</th>
                      <th className="px-3 py-2 font-medium">Periodo</th>
                      <th className="px-3 py-2 text-right font-medium">Movs.</th>
                      <th className="px-3 py-2 font-medium">Cuadre</th>
                      <th className="px-3 py-2 text-right font-medium">Documento</th>
                      <th className="px-5 py-2 text-right font-medium">Deshacer</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lotes.map((l) => (
                      <tr key={l.id} className="border-t border-cos-line-soft text-cos-ink-soft">
                        <td className="px-5 py-2.5 whitespace-nowrap">{new Date(l.createdAt).toLocaleDateString("es-MX", { day: "2-digit", month: "short", year: "numeric" })}</td>
                        <td className="px-3 py-2.5">{l.cuentaEtiqueta}</td>
                        <td className="px-3 py-2.5 font-mono text-[12.5px]">{l.periodo ?? "—"}</td>
                        <td className="px-3 py-2.5 text-right font-mono">{l.count}</td>
                        <td className="px-3 py-2.5">
                          {l.cuadro === true && <span className="rounded-full bg-cos-green-tint px-2 py-0.5 text-[12px] font-medium text-cos-green-ink">Cuadró</span>}
                          {l.cuadro === false && <span className="rounded-full bg-cos-amber-tint px-2 py-0.5 text-[12px] font-medium text-cos-amber-ink" title="Importado con confirmación manual: los saldos del estado no cuadraron con la suma de movimientos">Sin cuadrar</span>}
                          {l.cuadro == null && <span className="text-cos-ink-faint">—</span>}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          {l.tienePdf ? (
                            <a href={`/api/bancos/import-batches/${l.id}/pdf`} target="_blank" rel="noreferrer"
                              className="font-semibold text-cos-brand-ink hover:underline">Ver PDF</a>
                          ) : (
                            <span className="text-cos-ink-faint">—</span>
                          )}
                        </td>
                        {/* Deshacer POR LOTE: borra sólo lo que sigue sin conciliar
                            y conserva lo ya casado con factura. El conteo se ve
                            antes de decidir — sin sorpresas. */}
                        <td className="px-5 py-2.5 text-right whitespace-nowrap">
                          {l.borrables > 0 ? (
                            <button
                              onClick={() => deshacerLote(l)}
                              disabled={deshaciendo === l.id}
                              title={
                                `Borra ${l.borrables} movimiento(s) sin conciliar` +
                                (l.conciliados > 0 ? ` y conserva ${l.conciliados} ya conciliado(s)` : "")
                              }
                              className="inline-flex items-center gap-1.5 rounded-control border border-cos-line px-2.5 py-1 text-[12.5px] font-medium text-cos-red-ink hover:bg-cos-red-tint disabled:opacity-50"
                            >
                              {deshaciendo === l.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                              {l.borrables}
                            </button>
                          ) : (
                            <span className="text-[12px] text-cos-ink-faint" title="Todos sus movimientos ya están conciliados">
                              conciliado
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}

          {/* filter bar — histórico llega FIJADO en Conciliados: sin chips de
              estado ni selección en lote, sólo el corte por mes. */}
          {vista !== "cuentas" && (
          <div className="mt-5 flex flex-wrap items-center gap-2">
            {vista === "movimientos" && ([["all","Todos"],["UNMATCHED","Sin conciliar"],["MATCHED","Conciliados"]] as [Filter,string][]).map(([k, t]) => (
              <button key={k} onClick={() => setFilter(k)}
                className={"inline-flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-[13.5px] font-medium " + (filter === k ? "border-cos-brand bg-cos-brand text-white" : "border-cos-line bg-cos-card text-cos-ink-soft hover:border-cos-brand hover:text-cos-brand-ink")}>
                {t} <span className="font-mono text-[12px] opacity-80">{k === "all" ? (counts.total ?? 0) : k === "UNMATCHED" ? (counts.UNMATCHED ?? 0) : (counts.MATCHED ?? 0)}</span>
              </button>
            ))}
            {/* División por mes: acota lista Y conteos al mes elegido. */}
            {meses.length > 0 && (
              <select value={mes} onChange={(e) => setMes(e.target.value)}
                className={"cursor-pointer appearance-none rounded-full border px-3.5 py-2 text-[13.5px] font-medium outline-none " + (mes ? "border-cos-brand bg-cos-brand text-white" : "border-cos-line bg-cos-card text-cos-ink-soft hover:border-cos-brand hover:text-cos-brand-ink")}>
                <option value="">Todos los meses</option>
                {meses.map((m) => (
                  <option key={m.mes} value={m.mes}>{fmtMes(m.mes)} ({m.count})</option>
                ))}
              </select>
            )}
            {vista === "movimientos" && (
            <button onClick={() => setShowMore((v) => !v)}
              className={"inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-[13.5px] font-semibold text-cos-brand-ink hover:bg-cos-brand-tint " + (showMore ? "bg-cos-brand-tint" : "")}>
              <SlidersHorizontal className="h-3.5 w-3.5" /> Más filtros
              <ChevronDown className={"h-3.5 w-3.5 transition-transform " + (showMore ? "rotate-180" : "")} />
            </button>
            )}
            <span className="flex-1" />
            {vista === "movimientos" && (
            <button onClick={() => { setSelectMode((v) => !v); setPicked(new Set()); }}
              className={"inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-[13.5px] font-semibold " + (selectMode ? "bg-cos-ink text-cos-canvas" : "text-cos-ink-soft hover:bg-cos-paper")}>
              <CheckSquare className="h-4 w-4" /> {selectMode ? "Salir de selección" : "Seleccionar"}
            </button>
            )}
          </div>
          )}

          {/* secondary type filters */}
          {vista === "movimientos" && showMore && (
            <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-card border border-dashed border-cos-line bg-cos-paper px-4 py-3">
              <span className="mr-1 font-mono text-[11px] uppercase tracking-[0.08em] text-cos-ink-faint">Por tipo</span>
              {TIPO_CHIPS.map(({ f, t, k }) => (
                <button key={f} onClick={() => setFilter(f)}
                  className={"inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium " + (filter === f ? "border-cos-brand bg-cos-brand text-white" : "border-cos-line bg-cos-card text-cos-ink-soft hover:border-cos-brand hover:text-cos-brand-ink")}>
                  {t} <span className="font-mono text-[11px] opacity-70">{counts[k] ?? 0}</span>
                </button>
              ))}
            </div>
          )}

          {/* movements */}
          {vista !== "cuentas" && (
          <div className="mt-3 flex flex-col gap-3">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-cos-ink-faint"><Loader2 className="h-4 w-4 animate-spin" /> Cargando…</div>
            ) : errorTxs ? (
              /* Rama de ERROR, excluyente del vacío: un fetch caído jamás debe
                 leerse como "no hay movimientos". */
              <Alert tone="danger" action={<RetryButton onClick={loadTxs} />}>{errorTxs}</Alert>
            ) : txs.length === 0 ? (
              <Card className="rounded-card border-cos-line p-10 text-center text-cos-ink-faint shadow-card">No hay movimientos con ese filtro.</Card>
            ) : txs.map((m, i) => {
              const matched = m.status === "MATCHED";
              const ignored = m.status === "IGNORED";
              const isPicked = picked.has(m.id);
              // Separador de mes: solo en la vista "Todos los meses" (con un mes
              // elegido toda la lista es de ese mes y el separador estorba).
              const mesTx = String(m.fecha).slice(0, 7);
              const abreMes = !mes && (i === 0 || String(txs[i - 1].fecha).slice(0, 7) !== mesTx);
              return (
                <Fragment key={m.id}>
                {abreMes && (
                  <div className="mt-2 flex items-center gap-3 first:mt-0">
                    <span className="font-mono text-[11.5px] font-semibold uppercase tracking-[0.08em] text-cos-ink-faint">{fmtMes(mesTx)}</span>
                    <span className="h-px flex-1 bg-cos-line-soft" />
                  </div>
                )}
                <Card className={"rounded-card p-4 shadow-card " + (matched ? "border-cos-jade-tint bg-cos-jade-tint/40" : "border-cos-line")}>
                  <div className="flex items-start gap-3">
                    {selectMode && (
                      <button onClick={() => togglePick(m.id)} className="mt-1 flex-none">
                        {isPicked
                          ? <CheckSquare className="h-[18px] w-[18px] text-cos-brand" />
                          : <span className="block h-[18px] w-[18px] rounded-[5px] border-[1.5px] border-cos-line" />}
                      </button>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-mono text-[12.5px] text-cos-ink-faint">{fmtFechaCorta(m.fecha)}</span>
                        <Money value={m.monto} sign size={17} weight={700} />
                      </div>
                      {/* Cuando el banco nos dijo QUIÉN, ése es el titular del
                          movimiento — no la cadena cruda. Quien lee un estado
                          de cuenta busca la contraparte, no la sintaxis del
                          banco ("SPEI Enviado: | Institucion Receptora: … |
                          Cuenta Beneficiario: … RFC Beneficiario: …").
                          Sin contraparte extraída, la descripción sigue siendo
                          el titular: no se pierde nada. La cadena completa
                          queda siempre visible al expandir. */}
                      {m.contraparteNombre ? (
                        <p className="mt-2 text-[14.5px] font-semibold leading-snug text-cos-ink">
                          {m.contraparteNombre}
                        </p>
                      ) : (
                        <p className="mt-2 text-[14.5px] font-medium leading-snug text-cos-ink">{m.descripcion}</p>
                      )}
                      {/* La identidad extraída se enseña TENIÉNDOLA, con o sin
                          nombre: BBVA en los traspasos escribe sólo el RFC, y
                          esconderlo por no tener nombre era tirar el dato que
                          identifica a la contraparte. */}
                      {(m.conceptoPago || m.contraparteRfc || m.contraparteBanco) && (
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px] text-cos-ink-soft">
                          {m.conceptoPago && <span className="truncate">{m.conceptoPago}</span>}
                          {m.contraparteRfc && (
                            <span className="font-mono text-cos-ink">{m.contraparteRfc}</span>
                          )}
                          {m.contraparteBanco && <span>{m.contraparteBanco}</span>}
                        </div>
                      )}
                      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-3">
                        <span className="text-[12px] text-cos-ink-faint">
                          {[
                            // Algunos bancos pegan en `referencia` la MISMA cola
                            // que ya vive en la descripción («1525229544 RFC: …
                            // AUT: …»): repetirla es eco, no información. La
                            // cadena completa sigue visible al expandir.
                            m.referencia && !m.descripcion.includes(m.referencia) && (
                              <>Ref <span className="font-mono">{m.referencia}</span></>
                            ),
                            // La línea de captura identifica la declaración que
                            // este cargo pagó: es el dato que lo concilia.
                            m.lineaCaptura && (
                              <>LC <span className="font-mono">{m.lineaCaptura}</span></>
                            ),
                            m.saldo != null && (
                              <>Saldo <span className="font-mono">${m.saldo.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span></>
                            ),
                          ]
                            .filter(Boolean)
                            .map((parte, i) => (
                              <span key={i}>
                                {i > 0 && " · "}
                                {parte}
                              </span>
                            ))}
                        </span>
                        {statusChip(m)}
                      </div>

                      {/* De dónde sale esta comisión. Sin esto es un egreso
                          suelto que alguien mira y descarta a mano cada mes —
                          un renglón por cada SPEI. NO se netea contra el envío:
                          la comisión bancaria es un gasto real y deducible, con
                          su propio CFDI del banco. */}
                      {m.comisionDe && (
                        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12.5px] text-cos-ink-soft">
                          <Link2 className="h-[14px] w-[14px]" />
                          Comisión de la transferencia a{" "}
                          <b className="truncate">
                            {m.comisionDe.contraparteNombre ?? "otra cuenta"}
                          </b>
                          <Money value={m.comisionDe.monto} size={12.5} muted />
                        </div>
                      )}
                      {m.comisiones != null && m.comisiones.length > 0 && (
                        <div className="mt-2 text-[12.5px] text-cos-ink-faint">
                          + {m.comisiones.length === 1 ? "comisión" : `${m.comisiones.length} comisiones`}{" "}
                          <Money
                            value={m.comisiones.reduce((s, c) => s + c.monto, 0)}
                            size={12.5}
                            muted
                          />
                        </div>
                      )}

                      {matched && m.invoice && (
                        <div className="mt-3 border-t border-dashed border-cos-jade-tint pt-3 text-[13px] text-cos-jade-ink">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Link2 className="h-[15px] w-[15px]" /> Conciliado con{" "}
                            <b>{m.invoice.customer?.razonSocial ?? m.invoice.contraparteNombre ?? m.contraparteNombre ?? "factura"}</b>
                          </div>
                          {/* La factura concreta, no solo la contraparte: folio,
                              fecha y total — y enlace al CFDI por UUID. */}
                          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[12.5px] text-cos-ink-soft">
                            {(m.invoice.serie || m.invoice.folio) && (
                              <span className="font-mono">
                                {m.invoice.serie ?? ""}{m.invoice.folio ?? ""}
                              </span>
                            )}
                            {m.invoice.fecha && (
                              <span>
                                {new Date(m.invoice.fecha).toLocaleDateString("es-MX", { day: "2-digit", month: "short", year: "numeric" })}
                              </span>
                            )}
                            <Money value={m.invoice.total} size={12.5} muted />
                            <button
                              type="button"
                              onClick={() => setVerFacturaId(m.invoice!.id)}
                              className="font-semibold text-cos-brand-ink hover:underline"
                            >
                              Ver factura
                            </button>
                          </div>
                          {/* DESHACER. Estaba sólo en la conciliación uno-a-varios:
                              un movimiento conciliado 1:1 —la mayoría— no tenía
                              cómo revertirse desde la pantalla, aunque la acción
                              `unmatch` existiera desde siempre. Equivocarse
                              conciliando es normal; no poder corregirlo, no. */}
                          {!selectMode && (
                            <button onClick={() => desconciliar(m.id)} disabled={acting === m.id}
                              className="mt-2 text-[13px] font-semibold text-cos-red-ink hover:underline disabled:opacity-50">
                              {acting === m.id ? "…" : "Desconciliar"}
                            </button>
                          )}
                        </div>
                      )}

                      {/* Par de devolución vinculado (cualquiera de los dos lados). */}
                      {(m.devolucionDe || m.devolucionPor) && (
                        <div className="mt-3 border-t border-dashed border-cos-amber-tint pt-3">
                          <div className="flex items-center gap-1.5 text-[13px] text-cos-amber-ink">
                            <ArrowLeftRight className="h-[15px] w-[15px]" />
                            {m.devolucionDe ? (
                              <>Devolución del pago del <b>{new Date(m.devolucionDe.fecha).toLocaleDateString("es-MX", { day: "2-digit", month: "short" })}</b> — ambos se netean</>
                            ) : (
                              <>Este pago fue devuelto el <b>{new Date(m.devolucionPor!.fecha).toLocaleDateString("es-MX", { day: "2-digit", month: "short" })}</b> — no cuenta como pagado</>
                            )}
                          </div>
                          {!selectMode && (
                            <button onClick={() => desvincularDevolucion(m.id)} disabled={acting === m.id}
                              className="mt-2 text-[13px] font-semibold text-cos-red-ink hover:underline disabled:opacity-50">
                              {acting === m.id ? "…" : "Desvincular"}
                            </button>
                          )}
                        </div>
                      )}

                      {/* Sugerencia: probable devolución de un pago anterior. */}
                      {m.sugerenciaDevolucion && !m.devolucionDe && !m.devolucionPor && (
                        <div className="mt-3 rounded-md bg-cos-amber-tint px-3 py-2.5">
                          <div className="flex flex-wrap items-center gap-x-2 text-[13px] text-cos-amber-ink">
                            <ArrowLeftRight className="h-[15px] w-[15px]" />
                            ¿Es la devolución de este pago?{" "}
                            <b className="truncate">{m.sugerenciaDevolucion.descripcion}</b>
                            <span>· {new Date(m.sugerenciaDevolucion.fecha).toLocaleDateString("es-MX", { day: "2-digit", month: "short" })}</span>
                            <Money value={m.sugerenciaDevolucion.monto} size={13} muted />
                          </div>
                          {!selectMode && (
                            <button onClick={() => vincularDevolucion(m.id, m.sugerenciaDevolucion!.origenId)} disabled={acting === m.id}
                              className="mt-1.5 text-[13px] font-bold text-cos-amber-ink underline disabled:opacity-50">
                              {acting === m.id ? "…" : "Vincular como devolución"}
                            </button>
                          )}
                        </div>
                      )}

                      {/* Pago de impuestos conciliado (SIPARE / línea de captura). */}
                      {matched && !m.invoice && m.taxDeclaration && (
                        <div className="mt-3 border-t border-dashed border-cos-jade-tint pt-3">
                          <div className="flex items-center gap-1.5 text-[13px] text-cos-jade-ink">
                            <Building2 className="h-[15px] w-[15px]" /> Pago de impuestos: <b>{etiquetaImpuesto(m.taxDeclaration.tipo, m.taxDeclaration.periodo)}</b>
                          </div>
                          {!selectMode && (
                            <button onClick={() => desconciliar(m.id)} disabled={acting === m.id}
                              className="mt-2 text-[13px] font-semibold text-cos-red-ink hover:underline disabled:opacity-50">
                              {acting === m.id ? "…" : "Desconciliar"}
                            </button>
                          )}
                        </div>
                      )}

                      {/* Conciliación uno-a-varios: lista de facturas con su porción asignada. */}
                      {matched && !m.invoice && (m.conciliacionDetalles?.length ?? 0) > 0 && (
                        <div className="mt-3 border-t border-dashed border-cos-jade-tint pt-3">
                          <div className="flex items-center gap-1.5 text-[13px] text-cos-jade-ink">
                            <Link2 className="h-[15px] w-[15px]" /> Conciliado con <b>{m.conciliacionDetalles!.length} facturas</b>
                          </div>
                          <ul className="mt-2 flex flex-col gap-1">
                            {m.conciliacionDetalles!.map((d) => (
                              <li key={d.id} className="flex items-center justify-between gap-3 text-[12.5px] text-cos-ink-soft">
                                <span className="truncate">
                                  {d.invoice.customer?.razonSocial ?? "—"}
                                  {d.invoice.folio ? ` · ${d.invoice.serie ?? ""}${d.invoice.folio}` : ""}
                                </span>
                                <Money value={d.montoAsignado} size={12.5} muted />
                              </li>
                            ))}
                          </ul>
                          {!selectMode && (
                            <button onClick={() => desconciliar(m.id)} disabled={acting === m.id}
                              className="mt-2 text-[13px] font-semibold text-cos-red-ink hover:underline disabled:opacity-50">
                              {acting === m.id ? "…" : "Desconciliar"}
                            </button>
                          )}
                        </div>
                      )}

                      {ignored && !selectMode && (
                        <div className="mt-3 border-t border-dashed border-cos-line pt-3">
                          <button onClick={() => reabrir(m.id)} disabled={acting === m.id}
                            className="text-[13px] font-semibold text-cos-brand-ink hover:underline disabled:opacity-50">
                            {acting === m.id ? "…" : "Reabrir movimiento"}
                          </button>
                        </div>
                      )}

                      {!matched && !ignored && !selectMode && (
                        <div className="mt-3 border-t border-dashed border-cos-line pt-3">
                          <button onClick={() => expand(m)} className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-cos-brand-ink hover:underline">
                            <Search className="h-[15px] w-[15px]" /> {expandedId === m.id ? "Ocultar" : "Buscar coincidencia"}
                          </button>
                          {expandedId === m.id && (
                            <ResolverMovimiento
                              tx={m}
                              companyId={activeCompany.id}
                              onCambio={() => Promise.all([loadTxs(), loadAccounts()]).then(() => {})}
                              onToast={showToast}
                              onVerFactura={setVerFacturaId}
                              onRepSugerido={setRepSugerido}
                              onResuelto={() => setExpandedId(null)}
                            />
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </Card>
                </Fragment>
              );
            })}
          </div>
          )}

          {/* Seguir hacia atrás en el historial. Sin esto la lista se quedaba
              en la primera página y los meses viejos no existían para quien
              mira, aunque estuvieran importados. */}
          {vista !== "cuentas" && !loading && txs.length > 0 && pagina < paginas && (
            <div className="mt-4 flex flex-col items-center gap-1.5">
              <button
                onClick={cargarMas}
                disabled={cargandoMas}
                className="inline-flex items-center gap-2 rounded-control border border-cos-line bg-cos-card px-4 py-2.5 text-[13.5px] font-medium text-cos-ink hover:border-cos-brand hover:text-cos-brand-ink disabled:opacity-50"
              >
                {cargandoMas && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {cargandoMas ? "Cargando…" : "Cargar más movimientos"}
              </button>
              <span className="text-[12px] text-cos-ink-faint">
                {txs.length.toLocaleString("es-MX")} movimientos cargados · página {pagina} de {paginas}
              </span>
            </div>
          )}

          {/* Acciones en lote — el MISMO componente que la mesa monta bajo
              su lista: los tres endpoints de lote viven una sola vez. */}
          {selectMode && activeCompany && (
            <AccionesEnLote
              companyId={activeCompany.id}
              txIds={pickedIds}
              suma={pickedSum}
              conciliados={pickedConciliados}
              onToast={showToast}
              onListo={async () => {
                setPicked(new Set()); setSelectMode(false);
                await Promise.all([loadTxs(), loadAccounts()]);
              }}
            />
          )}
        </>
      )}

      {accountModal && activeCompany && (
        <AccountModal
          companyId={activeCompany.id}
          account={accountModal.account}
          onClose={() => setAccountModal(null)}
          onSaved={async () => { setAccountModal(null); await loadAccounts(); }}
        />
      )}

      {toast && <div className="fixed bottom-6 left-1/2 z-[90] -translate-x-1/2 rounded-xl bg-cos-ink px-5 py-3 text-sm font-medium text-cos-canvas shadow-lg">{toast}</div>}
      {repSugerido && activeCompany && (
        <AvisoRepSugerido
          rep={repSugerido}
          companyId={activeCompany.id}
          onCerrar={() => setRepSugerido(null)}
          onToast={showToast}
        />
      )}

      {verFacturaId && (
        <RepresentacionImpresa invoiceId={verFacturaId} onClose={() => setVerFacturaId(null)} />
      )}
    </div>
  );
}

// ── Modal: agregar / editar cuenta bancaria ─────────────────────────────────────
function AccountModal({
  companyId, account, onClose, onSaved,
}: {
  companyId: string;
  account: BankAccount | null;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const isEdit = !!account;
  const [banco, setBanco] = useState(account?.banco ?? "BBVA");
  const [nombre, setNombre] = useState(account?.nombre ?? "");
  const [numeroCuenta, setNumeroCuenta] = useState(account?.numeroCuenta ?? "");
  const [clabe, setClabe] = useState(account?.clabe ?? "");
  const [moneda, setMoneda] = useState(account?.moneda ?? "MXN");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!nombre.trim() || !numeroCuenta.trim()) {
      setError("Nombre y número de cuenta son obligatorios.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body = { banco, nombre: nombre.trim(), numeroCuenta: numeroCuenta.trim(), clabe: clabe.trim(), moneda };
      const res = isEdit
        ? await fetch(`/api/bancos/${account!.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        : await fetch(`/api/bancos`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ companyId, ...body }) });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? "No se pudo guardar la cuenta.");
        return;
      }
      await onSaved();
    } catch {
      setError("No se pudo guardar la cuenta.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <Card className="w-full max-w-[480px] rounded-card border-cos-line p-5 shadow-card">
        <div onClick={(e) => e.stopPropagation()}>
          <div className="flex items-start justify-between gap-3">
            <p className="text-[16px] font-semibold text-cos-ink">{isEdit ? "Editar cuenta" : "Agregar cuenta"}</p>
            <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-control text-cos-ink-soft hover:bg-cos-paper"><X className="h-5 w-5" /></button>
          </div>

          <div className="mt-4 space-y-3">
            <label className="block">
              <span className="text-[12.5px] font-medium text-cos-ink-soft">Banco</span>
              <select value={banco} onChange={(e) => setBanco(e.target.value)}
                className="mt-1 w-full rounded-control border border-cos-line bg-cos-card px-3 py-2 text-[13.5px] text-cos-ink outline-none focus:border-cos-brand">
                {BANKS.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </label>

            <label className="block">
              <span className="text-[12.5px] font-medium text-cos-ink-soft">Nombre / alias de la cuenta</span>
              <input value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Ej. Cuenta principal MXN"
                className="mt-1 w-full rounded-control border border-cos-line bg-cos-card px-3 py-2 text-[13.5px] text-cos-ink outline-none placeholder:text-cos-ink-faint focus:border-cos-brand" autoFocus />
            </label>

            <label className="block">
              <span className="text-[12.5px] font-medium text-cos-ink-soft">Número de cuenta</span>
              <input value={numeroCuenta} onChange={(e) => setNumeroCuenta(e.target.value)} placeholder="Ej. 0123456789"
                className="mt-1 w-full rounded-control border border-cos-line bg-cos-card px-3 py-2 text-[13.5px] font-mono text-cos-ink outline-none placeholder:text-cos-ink-faint focus:border-cos-brand" />
            </label>

            <label className="block">
              <span className="text-[12.5px] font-medium text-cos-ink-soft">CLABE <span className="text-cos-ink-faint">(opcional)</span></span>
              <input value={clabe} onChange={(e) => setClabe(e.target.value)} placeholder="18 dígitos"
                className="mt-1 w-full rounded-control border border-cos-line bg-cos-card px-3 py-2 text-[13.5px] font-mono text-cos-ink outline-none placeholder:text-cos-ink-faint focus:border-cos-brand" />
            </label>

            <label className="block">
              <span className="text-[12.5px] font-medium text-cos-ink-soft">Moneda</span>
              <select value={moneda} onChange={(e) => setMoneda(e.target.value)}
                className="mt-1 w-full rounded-control border border-cos-line bg-cos-card px-3 py-2 text-[13.5px] text-cos-ink outline-none focus:border-cos-brand">
                <option value="MXN">MXN — Peso mexicano</option>
                <option value="USD">USD — Dólar estadounidense</option>
                <option value="EUR">EUR — Euro</option>
              </select>
            </label>
          </div>

          {error && <p className="mt-3 text-[12.5px] text-cos-red-ink">{error}</p>}

          <div className="mt-4 flex justify-end gap-2">
            <button onClick={onClose} className="rounded-control border border-cos-line px-4 py-2 text-[13.5px] font-semibold text-cos-ink hover:bg-cos-paper">Cancelar</button>
            <button disabled={saving} onClick={save}
              className="inline-flex items-center gap-1.5 rounded-control bg-cos-brand px-4 py-2 text-[13.5px] font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {isEdit ? "Guardar cambios" : "Agregar cuenta"}
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}
