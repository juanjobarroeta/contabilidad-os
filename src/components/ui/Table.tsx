import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Tabla compartida. Antes cada página escribía su propio `<table>` (25
 * archivos) y la cabecera, el alto de renglón y la alineación de las columnas
 * de dinero divergían entre sí. Estas primitivas fijan ese vocabulario:
 *
 *   • cabecera en versalitas tenues, pegajosa cuando la tabla scrollea;
 *   • `numeric` alinea a la derecha y activa `tabular-nums`, para que las
 *     columnas de importes cuadren ópticamente renglón contra renglón —
 *     es la razón por la que un contador puede barrer una columna con la vista;
 *   • el contenedor aporta el borde, el redondeo y el scroll horizontal, así
 *     ninguna tabla ancha rompe el layout en móvil.
 */

/** Envoltura con borde + scroll horizontal. Una tabla ancha scrollea DENTRO. */
export function TableContainer({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "w-full overflow-x-auto rounded-card border border-cos-line bg-cos-card",
        className
      )}
      {...props}
    />
  );
}

export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return <table className={cn("w-full border-collapse text-sm", className)} {...props} />;
}

/**
 * Cabecera. `sticky` la mantiene visible al scrollear verticalmente — úsala
 * cuando el contenedor tenga una altura máxima (p.ej. `max-h-[70vh]`).
 */
export function THead({
  sticky,
  className,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement> & { sticky?: boolean }) {
  return (
    <thead
      className={cn(
        "bg-cos-paper text-[12px] uppercase tracking-[0.02em] text-cos-ink-faint",
        sticky && "sticky top-0 z-10",
        className
      )}
      {...props}
    />
  );
}

export function TBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={className} {...props} />;
}

/** Pie de totales: mismo fondo que la cabecera para cerrar visualmente la tabla. */
export function TFoot({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tfoot
      className={cn("border-t border-cos-line bg-cos-paper font-medium text-cos-ink", className)}
      {...props}
    />
  );
}

export function TR({
  interactive,
  selected,
  className,
  ...props
}: React.HTMLAttributes<HTMLTableRowElement> & { interactive?: boolean; selected?: boolean }) {
  return (
    <tr
      className={cn(
        "border-t border-cos-line transition-colors",
        interactive && "cursor-pointer hover:bg-cos-paper/60",
        selected && "bg-cos-brand-tint",
        className
      )}
      {...props}
    />
  );
}

/** `numeric` = derecha + `tabular-nums` (columnas de dinero y cantidades). */
export function TH({
  numeric,
  center,
  className,
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean; center?: boolean }) {
  return (
    <th
      scope="col"
      className={cn(
        "px-4 py-2.5 font-medium",
        numeric ? "text-right" : center ? "text-center" : "text-left",
        className
      )}
      {...props}
    />
  );
}

export function TD({
  numeric,
  center,
  className,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean; center?: boolean }) {
  return (
    <td
      className={cn(
        "px-4 py-3 align-middle",
        numeric ? "text-right tabular-nums" : center ? "text-center" : "text-left",
        className
      )}
      {...props}
    />
  );
}

/** Renglón de "no hay nada" que respeta el ancho de la tabla. */
export function TableEmpty({
  colSpan,
  children,
  className,
}: {
  colSpan: number;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <tr className="border-t border-cos-line">
      <td colSpan={colSpan} className={cn("px-4 py-10 text-center text-sm text-cos-ink-soft", className)}>
        {children}
      </td>
    </tr>
  );
}
