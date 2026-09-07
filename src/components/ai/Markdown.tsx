"use client";

// Render markdown del asistente con estilos cos- compactos. Antes el chat
// mostraba texto plano (whitespace-pre-wrap), así que los **negritas**, listas y
// tablas salían como asteriscos y guiones crudos. Mapeamos cada elemento a algo
// legible y discreto, pensado para burbujas de chat (no documento largo).

import Link from "next/link";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { esEnlaceInterno } from "@/lib/ui/enlace";

const components: Components = {
  p: ({ children }) => <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-cos-ink">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  ul: ({ children }) => <ul className="mb-2 list-disc space-y-0.5 pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 list-decimal space-y-0.5 pl-5 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  h1: ({ children }) => <h1 className="mb-1.5 mt-1 text-[15px] font-semibold text-cos-ink">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-1.5 mt-1 text-[14px] font-semibold text-cos-ink">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1 mt-1 text-[13.5px] font-semibold text-cos-ink">{children}</h3>,
  // Una ruta de la app navega DENTRO de la ventana; sólo lo que sale a otro
  // sitio abre pestaña. Antes todo abría pestaña nueva, así que tocar «Mapear
  // cuentas» arrancaba una segunda copia de la aplicación en vez de llevarte
  // a la pantalla.
  a: ({ children, href }) => {
    const clases = "text-cos-brand-ink underline underline-offset-2 hover:opacity-80";
    if (esEnlaceInterno(href)) {
      return <Link href={href!} className={clases}>{children}</Link>;
    }
    return (
      <a href={href} target="_blank" rel="noreferrer" className={clases}>{children}</a>
    );
  },
  code: ({ children }) => (
    <code className="rounded bg-cos-paper px-1 py-0.5 font-mono text-[12px] text-cos-ink">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="mb-2 overflow-x-auto rounded-control bg-cos-paper p-2.5 font-mono text-[12px] text-cos-ink last:mb-0">{children}</pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mb-2 border-l-2 border-cos-line pl-3 text-cos-ink-soft last:mb-0">{children}</blockquote>
  ),
  hr: () => <hr className="my-2.5 border-cos-line-soft" />,
  table: ({ children }) => (
    <div className="mb-2 overflow-x-auto last:mb-0">
      <table className="w-full border-collapse text-[12.5px]">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border border-cos-line-soft bg-cos-paper px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border border-cos-line-soft px-2 py-1">{children}</td>,
};

export function Markdown({ children }: { children: string }) {
  return (
    <div className="text-sm text-cos-ink">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
