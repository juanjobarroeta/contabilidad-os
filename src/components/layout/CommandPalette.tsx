"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, CornerDownLeft, Building2, ArrowRight } from "lucide-react";
import { useCompany } from "./CompanyProvider";
import { cn } from "@/lib/utils";
import { DESTINOS, buscarDestinos, normalizar, type Destino } from "@/lib/navigation";

/**
 * Búsqueda global (⌘K / Ctrl-K).
 *
 * La app tiene ~45 pantallas y ninguna forma de saltar entre ellas sin
 * recorrer el menú con el ratón. Para el usuario objetivo —un contador que
 * viene de capturar en COI con puro teclado— eso es el costo más caro de la
 * interfaz. El paletón resuelve dos saltos en el mismo lugar:
 *
 *   1. IR A una pantalla, incluyendo las que el menú no lista.
 *   2. CAMBIAR DE EMPRESA, que en un despacho de 40 RFC es el gesto más
 *      repetido del día y hoy vive detrás de un desplegable que hay que
 *      scrollear.
 */

type Fila =
  | { kind: "destino"; d: Destino }
  | { kind: "empresa"; id: string; razonSocial: string; rfc: string };

export function CommandPalette({ esOperador }: { esOperador?: boolean }) {
  const router = useRouter();
  const { companies, activeCompany, setActiveCompany } = useCompany();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // ⌘K / Ctrl-K abre; Esc cierra. Se registra en captura para ganarle a los
  // inputs de la página (si no, teclear ⌘K dentro de un campo no haría nada).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Un botón en la barra lateral (y el de móvil) dispara este evento — así el
  // paletón no necesita que la barra le pase props ni un contexto extra.
  useEffect(() => {
    const abrir = () => setOpen(true);
    window.addEventListener("cos:abrir-buscador", abrir);
    return () => window.removeEventListener("cos:abrir-buscador", abrir);
  }, []);

  // Cada apertura empieza en blanco: reusar la búsqueda anterior obliga a
  // borrarla antes de teclear la nueva.
  useEffect(() => {
    if (open) {
      setQ("");
      setCursor(0);
      // El foco va después del paint, o el navegador lo pierde al montar.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const filas = useMemo<Fila[]>(() => {
    const visibles = DESTINOS.filter((d) => !d.operador || esOperador);
    const destinos: Fila[] = buscarDestinos(visibles, q).map((d) => ({ kind: "destino", d }));

    // Las empresas sólo aparecen al escribir algo — sin filtro llenarían la
    // lista y taparían la navegación, que es el uso más frecuente.
    const term = normalizar(q.trim());
    const empresas: Fila[] = !term
      ? []
      : companies
          .filter(
            (c) =>
              normalizar(c.razonSocial).includes(term) || normalizar(c.rfc).includes(term)
          )
          .slice(0, 6)
          .map((c) => ({
            kind: "empresa" as const,
            id: c.id,
            razonSocial: c.razonSocial,
            rfc: c.rfc,
          }));

    return [...empresas, ...destinos];
  }, [q, companies, esOperador]);

  // Si la lista se acorta al teclear, el cursor no puede quedar fuera de rango.
  useEffect(() => {
    setCursor((c) => (c >= filas.length ? 0 : c));
  }, [filas.length]);

  const ejecutar = (fila: Fila) => {
    setOpen(false);
    if (fila.kind === "destino") {
      router.push(fila.d.href);
    } else {
      const c = companies.find((x) => x.id === fila.id);
      if (c) setActiveCompany(c);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => (filas.length ? (c + 1) % filas.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => (filas.length ? (c - 1 + filas.length) % filas.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const fila = filas[cursor];
      if (fila) ejecutar(fila);
    }
  };

  // Mantiene visible el renglón seleccionado al navegar con las flechas.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (!open) return null;

  // Encabezado de grupo antes del primer renglón de cada sección.
  const grupoDe = (f: Fila) => (f.kind === "empresa" ? "Cambiar de empresa" : f.d.grupo);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/40 px-4 pt-[12vh]"
      onMouseDown={() => setOpen(false)}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Búsqueda global"
        className="w-full max-w-xl overflow-hidden rounded-card border border-cos-line bg-cos-card shadow-card"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-cos-line px-4">
          <Search className="h-4 w-4 shrink-0 text-cos-ink-faint" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Buscar pantallas, empresas, RFC…"
            aria-label="Buscar"
            role="combobox"
            aria-expanded={filas.length > 0}
            aria-controls="cmd-listbox"
            aria-activedescendant={filas.length > 0 ? `cmd-opt-${cursor}` : undefined}
            aria-autocomplete="list"
            className="h-12 flex-1 bg-transparent text-[15px] text-cos-ink outline-none placeholder:text-cos-ink-faint"
          />
          <kbd className="hidden rounded border border-cos-line px-1.5 py-0.5 font-mono text-[10px] text-cos-ink-faint sm:block">
            ESC
          </kbd>
        </div>

        <div
          ref={listRef}
          id="cmd-listbox"
          role="listbox"
          aria-label="Resultados"
          className="max-h-[52vh] overflow-y-auto py-2"
        >
          {filas.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-cos-ink-soft">
              Nada coincide con «{q}».
            </p>
          )}

          {filas.map((f, i) => {
            const grupo = grupoDe(f);
            const nuevoGrupo = i === 0 || grupoDe(filas[i - 1]) !== grupo;
            const activo = i === cursor;
            return (
              <div key={f.kind === "empresa" ? `e-${f.id}` : `d-${f.d.href}`} role="presentation">
                {nuevoGrupo && (
                  <p
                    role="presentation"
                    className="px-4 pb-1 pt-3 font-mono text-[10px] font-semibold uppercase tracking-[0.13em] text-cos-ink-faint"
                  >
                    {grupo}
                  </p>
                )}
                <button
                  id={`cmd-opt-${i}`}
                  role="option"
                  aria-selected={activo}
                  data-idx={i}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => ejecutar(f)}
                  className={cn(
                    "flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors",
                    activo ? "bg-cos-brand-tint text-cos-brand-ink" : "text-cos-ink hover:bg-cos-paper"
                  )}
                >
                  {f.kind === "empresa" ? (
                    <>
                      <Building2 className="h-4 w-4 shrink-0 text-cos-ink-soft" />
                      <span className="min-w-0 flex-1 truncate">
                        {f.razonSocial}
                        <span className="ml-2 font-mono text-[11px] text-cos-ink-faint">{f.rfc}</span>
                      </span>
                      {activeCompany?.id === f.id && (
                        <span className="shrink-0 text-[11px] text-cos-ink-faint">activa</span>
                      )}
                    </>
                  ) : (
                    <>
                      <ArrowRight className="h-4 w-4 shrink-0 text-cos-ink-faint" />
                      <span className="min-w-0 flex-1 truncate">{f.d.label}</span>
                    </>
                  )}
                  {activo && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 opacity-60" />}
                </button>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-4 border-t border-cos-line px-4 py-2 text-[11px] text-cos-ink-faint">
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-cos-line px-1 font-mono">↑</kbd>
            <kbd className="rounded border border-cos-line px-1 font-mono">↓</kbd> navegar
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-cos-line px-1 font-mono">↵</kbd> abrir
          </span>
        </div>
      </div>
    </div>
  );
}
