import Link from "next/link";
import {
  ArrowRight,
  Banknote,
  Building2,
  CheckCircle2,
  FileCheck2,
  Landmark,
  Lock,
  MessageCircle,
  RefreshCw,
  ShieldCheck,
  Users,
} from "lucide-react";

// Landing pública de marketing en la raíz del dominio (sin sesión). El pitch
// está dirigido al socio/dueño de un despacho contable; el CTA principal es la
// prueba gratis y el secundario agendar una demo. Reglas del material: español
// formal, sin testimonios ni cifras inventadas, sin prometer roadmap como
// existente. Los precios de lista coinciden con el onboarding (PLANS) y con
// los Price de Stripe — mantener en sincronía al cambiarlos.

const DEMO_MAILTO =
  "mailto:juanjosebarroetah@gmail.com?subject=Demo%20ContabilidadOS&body=Hola%2C%20me%20interesa%20una%20demo%20para%20mi%20despacho.";

const FEATURES = [
  {
    icon: RefreshCw,
    title: "SAT sincronizado, sin capturar",
    desc: "Conecta la e.firma y los CFDIs de hasta 5 años se descargan y clasifican solos: emitidos, recibidos, nómina y complementos. El monitoreo de la opinión de cumplimiento y la revisión 69-B de contrapartes corren en automático.",
  },
  {
    icon: MessageCircle,
    title: "WhatsApp como canal de operación",
    desc: "Tu cliente manda el estado de cuenta por WhatsApp y queda importado y categorizado. Tú consultas cualquier empresa de tu cartera por chat, como si le preguntaras a tu contador de confianza.",
  },
  {
    icon: Users,
    title: "Nómina 2026 completa",
    desc: "Cálculo verificado contra el DOF e IMSS (tarifas, UMA, vacaciones reformadas), timbrado con candado anti-duplicados, finiquitos, y el roster se da de alta solo desde los recibos históricos.",
  },
  {
    icon: Building2,
    title: "Toda tu cartera en un tablero",
    desc: "Multi-RFC de origen: roles por colaborador con alcance por empresa, tablero consolidado de la cartera y vista multi-empresa de nómina. Diseñado para despachos, no adaptado después.",
  },
  {
    icon: FileCheck2,
    title: "Facturación que no se equivoca",
    desc: "Timbrado, notas de crédito y complementos de pago de un toque sobre el saldo insoluto. IVA tasa 0 y exento tratados correctamente, con avisos preventivos y claves SAT verificadas contra el catálogo oficial.",
  },
  {
    icon: Landmark,
    title: "Bancos conciliados en automático",
    desc: "Categorización con reglas que aprenden de tus correcciones, conciliación contra CFDIs, deshacer importaciones y candados para no cargar movimientos a la empresa equivocada.",
  },
];

const TRUST = [
  {
    icon: ShieldCheck,
    title: "La IA no timbra sola",
    desc: "El asistente consulta y redacta; los números los calcula un motor determinista con más de mil pruebas automatizadas. Ninguna acción fiscal ocurre sin tu autorización dentro de la app.",
  },
  {
    icon: Lock,
    title: "Tus credenciales, cifradas",
    desc: "FIEL, CSD y CIEC se guardan cifradas y nunca circulan por chat. Las acciones irreversibles exigen volver a autenticarte: un «sí» por WhatsApp no basta, por diseño.",
  },
  {
    icon: Banknote,
    title: "Tus datos son tuyos",
    desc: "La información es de tu despacho y de tus clientes, y es exportable. Los CFDIs, además, siempre viven en el SAT: conectarte no te encierra.",
  },
];

const PASOS = [
  {
    n: "1",
    title: "Conecta la e.firma",
    desc: "Hasta 5 años de historia fiscal se importan y clasifican en la primera sincronización.",
  },
  {
    n: "2",
    title: "Vincula los bancos",
    desc: "Por conexión bancaria o mandando el estado de cuenta por WhatsApp. La categorización corre sola.",
  },
  {
    n: "3",
    title: "Opera tu cartera",
    desc: "Impuestos, nómina, facturación y cumplimiento de todas tus empresas, en un solo lugar.",
  },
];

export function Landing() {
  return (
    <div className="min-h-screen bg-cos-canvas text-cos-ink">
      {/* ── Nav ── */}
      <header className="border-b border-cos-line">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <span className="text-lg font-bold tracking-tight">ContabilidadOS</span>
          <nav className="flex items-center gap-3">
            <Link
              href="/login"
              className="rounded-md px-3 py-2 text-sm font-medium text-cos-ink-soft hover:text-cos-ink"
            >
              Iniciar sesión
            </Link>
            <Link
              href="/signup"
              className="rounded-md bg-cos-brand px-4 py-2 text-sm font-semibold text-white hover:bg-cos-brand-deep"
            >
              Crear cuenta
            </Link>
          </nav>
        </div>
      </header>

      {/* ── Hero ── */}
      <section className="mx-auto max-w-6xl px-6 pb-16 pt-20 text-center">
        <p className="mb-4 inline-block rounded-full border border-cos-line bg-cos-card px-3 py-1 text-xs font-semibold uppercase tracking-wide text-cos-ink-soft">
          Para despachos contables y sus clientes
        </p>
        <h1 className="mx-auto max-w-3xl text-4xl font-bold leading-tight sm:text-5xl">
          La contabilidad de tu despacho, en automático
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-lg text-cos-ink-soft">
          CFDIs que se descargan solos, bancos que llegan por WhatsApp, nómina verificada contra el
          DOF y toda tu cartera de clientes en un tablero. Tú pones el criterio; el sistema pone las
          horas.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/signup"
            className="inline-flex items-center gap-2 rounded-md bg-cos-brand px-6 py-3 text-sm font-semibold text-white hover:bg-cos-brand-deep"
          >
            Empieza tu prueba gratis <ArrowRight className="h-4 w-4" />
          </Link>
          <a
            href={DEMO_MAILTO}
            className="inline-flex items-center gap-2 rounded-md border border-cos-line bg-cos-card px-6 py-3 text-sm font-semibold text-cos-ink hover:border-cos-brand/40"
          >
            Agenda una demo para tu despacho
          </a>
        </div>
        <p className="mt-3 text-xs text-cos-ink-faint">Sin tarjeta. La prueba incluye acceso completo.</p>
      </section>

      {/* ── Cómo funciona ── */}
      <section className="border-y border-cos-line bg-cos-paper">
        <div className="mx-auto grid max-w-6xl gap-8 px-6 py-14 sm:grid-cols-3">
          {PASOS.map((p) => (
            <div key={p.n} className="text-center sm:text-left">
              <div className="mx-auto mb-3 flex h-9 w-9 items-center justify-center rounded-full bg-cos-brand-tint text-sm font-bold text-cos-brand-ink sm:mx-0">
                {p.n}
              </div>
              <h3 className="font-semibold">{p.title}</h3>
              <p className="mt-1 text-sm text-cos-ink-soft">{p.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Features ── */}
      <section className="mx-auto max-w-6xl px-6 py-16">
        <h2 className="text-center text-2xl font-bold sm:text-3xl">
          Lo que hoy te come el día, resuelto
        </h2>
        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-card border border-cos-line bg-cos-card p-6 shadow-card">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-cos-brand-tint text-cos-brand-ink">
                <f.icon className="h-5 w-5" />
              </div>
              <h3 className="font-semibold">{f.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-cos-ink-soft">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Confianza ── */}
      <section className="border-y border-cos-line bg-cos-paper">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="text-center text-2xl font-bold sm:text-3xl">
            Hecho para que puedas confiarle la llave
          </h2>
          <div className="mt-10 grid gap-5 sm:grid-cols-3">
            {TRUST.map((t) => (
              <div key={t.title} className="rounded-card border border-cos-line bg-cos-card p-6">
                <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-cos-jade-tint text-cos-jade-ink">
                  <t.icon className="h-5 w-5" />
                </div>
                <h3 className="font-semibold">{t.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-cos-ink-soft">{t.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Precios ── */}
      <section className="mx-auto max-w-6xl px-6 py-16">
        <h2 className="text-center text-2xl font-bold sm:text-3xl">Precios simples</h2>
        <p className="mx-auto mt-2 max-w-xl text-center text-sm text-cos-ink-soft">
          Por empresa, por mes. El plan anual equivale a 10 meses.
        </p>
        <div className="mx-auto mt-10 grid max-w-4xl gap-5 sm:grid-cols-3">
          <div className="rounded-card border border-cos-line bg-cos-card p-6">
            <h3 className="font-semibold">Básico</h3>
            <p className="mt-2 text-3xl font-bold">
              $499 <span className="text-sm font-normal text-cos-ink-soft">MXN/mes</span>
            </p>
            <ul className="mt-4 space-y-2 text-sm text-cos-ink-soft">
              {["Sincronización SAT", "Consultas y reportes", "Declaraciones"].map((x) => (
                <li key={x} className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-cos-jade-ink" /> {x}
                </li>
              ))}
            </ul>
          </div>
          <div className="relative rounded-card border-2 border-cos-brand bg-cos-card p-6">
            <span className="absolute -top-3 left-6 rounded-full bg-cos-brand px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
              Recomendado
            </span>
            <h3 className="font-semibold">Profesional</h3>
            <p className="mt-2 text-3xl font-bold">
              $1,299 <span className="text-sm font-normal text-cos-ink-soft">MXN/mes</span>
            </p>
            <ul className="mt-4 space-y-2 text-sm text-cos-ink-soft">
              {[
                "Todo lo de Básico",
                "Asistente IA + WhatsApp",
                "Conciliación bancaria",
                "Complementos de pago",
              ].map((x) => (
                <li key={x} className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-cos-jade-ink" /> {x}
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-card border border-cos-line bg-cos-card p-6">
            <h3 className="font-semibold">Despachos</h3>
            <p className="mt-2 text-3xl font-bold">A tu medida</p>
            <p className="mt-4 text-sm leading-relaxed text-cos-ink-soft">
              Multiempresa con precio por volumen según tu cartera. Cuéntanos cuántas empresas
              llevas y armamos tu propuesta.
            </p>
            <a
              href={DEMO_MAILTO}
              className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-cos-brand-ink hover:underline"
            >
              Agenda una demo <ArrowRight className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>
      </section>

      {/* ── CTA final ── */}
      <section className="border-t border-cos-line bg-cos-paper">
        <div className="mx-auto max-w-6xl px-6 py-16 text-center">
          <h2 className="text-2xl font-bold sm:text-3xl">
            La demo se hace con tus propios CFDIs
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-sm text-cos-ink-soft">
            Veinte minutos: conectamos una e.firma, la historia fiscal se importa sola y ves tu
            operación real dentro del sistema. Sin diapositivas.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/signup"
              className="inline-flex items-center gap-2 rounded-md bg-cos-brand px-6 py-3 text-sm font-semibold text-white hover:bg-cos-brand-deep"
            >
              Crear cuenta <ArrowRight className="h-4 w-4" />
            </Link>
            <a
              href={DEMO_MAILTO}
              className="inline-flex items-center gap-2 rounded-md border border-cos-line bg-cos-card px-6 py-3 text-sm font-semibold text-cos-ink hover:border-cos-brand/40"
            >
              Escríbenos
            </a>
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-cos-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-6 text-xs text-cos-ink-faint">
          <span>ContabilidadOS — Sistema contable y fiscal mexicano</span>
          <span className="flex gap-4">
            <Link href="/legal/aviso-de-privacidad" className="hover:text-cos-brand-ink hover:underline">
              Aviso de Privacidad
            </Link>
            <Link href="/legal/terminos" className="hover:text-cos-brand-ink hover:underline">
              Términos y Condiciones
            </Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
