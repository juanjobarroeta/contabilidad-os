"use client";

import { useEffect, useRef, useState } from "react";
import { Search, Loader2, Check } from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Generic SAT code picker — combobox that proxies search to Facturapi via
// our /api/sat/catalogs/* endpoints. Used for both clave producto/servicio
// and clave de unidad.
// ─────────────────────────────────────────────────────────────────────────────

type Result = { key: string; description: string };

export function SatCodePicker({
  companyId,
  endpoint,
  value,
  onChange,
  placeholder = "Buscar (mín. 3 letras)…",
  recentKey,
}: {
  companyId: string;
  /** "products" or "units" — maps to /api/sat/catalogs/{endpoint} */
  endpoint: "products" | "units";
  value: string;
  onChange: (key: string, description: string) => void;
  placeholder?: string;
  /** Optional localStorage key for "recently used" suggestions */
  recentKey?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [recent, setRecent] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [valueLabel, setValueLabel] = useState<string>("");
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Load recents from localStorage
  useEffect(() => {
    if (!recentKey) return;
    try {
      const stored = JSON.parse(localStorage.getItem(recentKey) ?? "[]");
      if (Array.isArray(stored)) setRecent(stored.slice(0, 8));
    } catch { /* ignore */ }
  }, [recentKey]);

  // Show the current value's label even when the dropdown is closed
  useEffect(() => {
    if (!value) { setValueLabel(""); return; }
    // Look up in recents first
    const r = recent.find(x => x.key === value);
    if (r) { setValueLabel(r.description); return; }
    // Else just show the code
    setValueLabel("");
  }, [value, recent]);

  // Debounced search
  useEffect(() => {
    if (!open) return;
    if (query.trim().length < 3) { setResults([]); return; }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ companyId, q: query.trim() });
        const res = await fetch(`/api/sat/catalogs/${endpoint}?${params}`);
        const data = await res.json();
        if (!cancelled) {
          // Map units endpoint result shape (key, name) to Result
          const arr = (data.data ?? []).map((d: { key: string; description?: string; name?: string; symbol?: string | null }) => ({
            key: d.key,
            description: d.description ?? d.name ?? "",
          })).filter((r: Result) => r.key && r.description);
          setResults(arr);
        }
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, endpoint, companyId, open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  function pick(r: Result) {
    onChange(r.key, r.description);
    setValueLabel(r.description);
    setOpen(false);
    setQuery("");

    // Save to recents
    if (recentKey) {
      try {
        const stored = JSON.parse(localStorage.getItem(recentKey) ?? "[]") as Result[];
        const dedup = [r, ...stored.filter(x => x.key !== r.key)].slice(0, 8);
        localStorage.setItem(recentKey, JSON.stringify(dedup));
        setRecent(dedup);
      } catch { /* ignore */ }
    }
  }

  const showRecents = open && query.trim().length < 3 && recent.length > 0;
  const showResults = open && query.trim().length >= 3;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full px-3 py-2 border border-cos-line rounded-md text-sm text-left bg-white hover:bg-cos-slate-tint flex items-center gap-2"
      >
        {value ? (
          <span className="flex-1 truncate">
            <span className="font-mono text-xs text-cos-ink-soft mr-2">{value}</span>
            {valueLabel || <span className="text-cos-ink-soft">(seleccionado)</span>}
          </span>
        ) : (
          <span className="flex-1 text-cos-ink-soft">{placeholder}</span>
        )}
        <Search className="h-3.5 w-3.5 text-cos-ink-soft shrink-0" />
      </button>

      {open && (
        <div className="absolute z-20 mt-1 w-full bg-white border border-cos-line rounded-md shadow-lg max-h-72 overflow-auto">
          <div className="p-2 border-b border-cos-line">
            <div className="relative">
              <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-cos-ink-soft" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Escribe para buscar…"
                className="w-full pl-8 pr-3 py-1.5 border border-cos-line rounded-md text-xs focus:outline-none focus:ring-2 focus:ring-cos-brand/30"
              />
            </div>
          </div>

          {showRecents && (
            <div>
              <p className="px-3 py-1.5 text-[10px] font-semibold text-cos-ink-soft uppercase tracking-wide">Usados recientemente</p>
              <ul>
                {recent.map(r => (
                  <PickerRow key={r.key} r={r} selected={r.key === value} onPick={pick} />
                ))}
              </ul>
            </div>
          )}

          {showResults && (
            <div>
              {loading ? (
                <div className="px-3 py-4 text-xs text-cos-ink-soft flex items-center gap-2 justify-center">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Buscando…
                </div>
              ) : results.length === 0 ? (
                <p className="px-3 py-4 text-xs text-cos-ink-soft text-center">Sin resultados</p>
              ) : (
                <ul>
                  {results.map(r => (
                    <PickerRow key={r.key} r={r} selected={r.key === value} onPick={pick} />
                  ))}
                </ul>
              )}
            </div>
          )}

          {!showRecents && !showResults && (
            <p className="px-3 py-4 text-xs text-cos-ink-soft text-center">
              Escribe al menos 3 letras para buscar en el catálogo SAT
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function PickerRow({
  r, selected, onPick,
}: { r: Result; selected: boolean; onPick: (r: Result) => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onPick(r)}
        className={`w-full text-left px-3 py-2 hover:bg-cos-paper flex items-start gap-2 ${selected ? "bg-cos-brand-tint" : ""}`}
      >
        <span className="font-mono text-[11px] text-cos-ink-soft mt-0.5 shrink-0">{r.key}</span>
        <span className="flex-1 text-xs">{r.description}</span>
        {selected && <Check className="h-3.5 w-3.5 text-cos-brand-ink shrink-0" />}
      </button>
    </li>
  );
}
