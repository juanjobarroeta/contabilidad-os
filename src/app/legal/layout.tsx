import Link from "next/link";

/**
 * Layout público para documentos legales (/legal/*). No requiere sesión:
 * estas páginas deben poder leerse antes de crear una cuenta.
 *
 * La tipografía de los documentos se resuelve aquí con variantes arbitrarias
 * de Tailwind sobre el <article>, para que las páginas hijas solo escriban
 * HTML semántico (h2, h3, p, ul, table) sin repetir clases.
 */
export default function LegalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-cos-canvas">
      <header className="border-b border-cos-line bg-cos-card">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/login" className="font-bold text-cos-ink">
            ContabilidadOS
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link
              href="/legal/aviso-de-privacidad"
              className="text-cos-ink-soft hover:text-cos-brand-ink hover:underline"
            >
              Aviso de Privacidad
            </Link>
            <Link
              href="/legal/terminos"
              className="text-cos-ink-soft hover:text-cos-brand-ink hover:underline"
            >
              Términos y Condiciones
            </Link>
            <Link
              href="/legal/mandato-efirma"
              className="text-cos-ink-soft hover:text-cos-brand-ink hover:underline"
            >
              Uso de la e.firma
            </Link>
          </nav>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-10">
        <article
          className="text-sm leading-relaxed text-cos-ink-soft space-y-4
            [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:text-cos-ink [&_h1]:leading-snug
            [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-cos-ink
            [&_h3]:mt-5 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-cos-ink
            [&_strong]:font-semibold [&_strong]:text-cos-ink
            [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:space-y-1.5
            [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:space-y-1.5
            [&_a]:text-cos-brand-ink [&_a]:underline-offset-2 hover:[&_a]:underline"
        >
          {children}
        </article>
      </main>

      <footer className="border-t border-cos-line">
        <div className="max-w-3xl mx-auto px-6 py-6 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-cos-ink-faint">
          <span>ContabilidadOS</span>
          <Link href="/legal/aviso-de-privacidad" className="hover:text-cos-brand-ink hover:underline">
            Aviso de Privacidad
          </Link>
          <Link href="/legal/terminos" className="hover:text-cos-brand-ink hover:underline">
            Términos y Condiciones
          </Link>
          <Link href="/legal/mandato-efirma" className="hover:text-cos-brand-ink hover:underline">
            Uso de la e.firma
          </Link>
        </div>
      </footer>
    </div>
  );
}
