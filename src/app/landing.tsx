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
//
// PALETA: azul marino + blanco (la misma del deck de ventas), deliberadamente
// independiente de los tokens cos-* de la app — la landing siempre se ve así,
// sin importar el tema claro/oscuro del visitante. Colores fijos:
//   fondo #081527 · paneles #0A1D3A · acento #8FB8F2 · texto suave #B8CCEB

const DEMO_MAILTO =
  "mailto:juanjosebarroetah@gmail.com?subject=Demo%20ContabilidadOS&body=Hola%2C%20me%20interesa%20una%20demo%20para%20mi%20despacho.";

const ACENTO = "text-[#8FB8F2]";
const SUAVE = "text-[#B8CCEB]";
const FAINT = "text-[#7E96BD]";
const CARD = "rounded-2xl border border-white/10 bg-white/[0.04]";
const BTN_PRIMARIO =
  "inline-flex items-center gap-2 rounded-lg bg-white px-6 py-3 text-sm font-semibold text-[#0A1D3A] hover:bg-[#DCE9FB]";
const BTN_SECUNDARIO =
  "inline-flex items-center gap-2 rounded-lg border border-white/25 px-6 py-3 text-sm font-semibold text-white hover:border-[#8FB8F2] hover:text-[#8FB8F2]";

function Logo() {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className="flex h-8 w-8 items-center justify-center rounded-[10px] border-2 border-white">
        <span className="ml-2 mt-2 h-2.5 w-2.5 rounded-full bg-[#8FB8F2]" />
      </span>
      <span className="text-lg font-bold tracking-tight text-white">
        Contabilidad <span className={ACENTO}>OS</span>
      </span>
    </span>
  );
}

const CHIPS = ["SAT automático", "Multi-RFC", "WhatsApp", "Nómina 2026"];

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
    n: "01",
    title: "Conecta la e.firma",
    desc: "Hasta 5 años de historia fiscal se importan y clasifican en la primera sincronización.",
  },
  {
    n: "02",
    title: "Vincula los bancos",
    desc: "Por conexión bancaria o mandando el estado de cuenta por WhatsApp. La categorización corre sola.",
  },
  {
    n: "03",
    title: "Opera tu cartera",
    desc: "Impuestos, nómina, facturación y cumplimiento de todas tus empresas, en un solo lugar.",
  },
];

export function Landing() {
  return (
    <div className="min-h-screen bg-[#081527] text-white">
      {/* ── Nav ── */}
      <header className="border-b border-white/10">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Logo />
          <nav className="flex items-center gap-3">
            <Link
              href="/login"
              className={`rounded-md px-3 py-2 text-sm font-medium ${SUAVE} hover:text-white`}
            >
              Iniciar sesión
            </Link>
            <Link
              href="/signup"
              className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-[#0A1D3A] hover:bg-[#DCE9FB]"
            >
              Crear cuenta
            </Link>
          </nav>
        </div>
      </header>

      {/* ── Hero ── */}
      <section className="bg-gradient-to-b from-[#0E2A52] via-[#0A1D3A] to-[#081527]">
        <div className="mx-auto max-w-6xl px-6 pb-20 pt-24 text-center">
          <p className={`mb-5 text-xs font-semibold uppercase tracking-[0.2em] ${FAINT}`}>
            Para despachos contables y sus clientes
          </p>
          <h1 className="mx-auto max-w-3xl text-4xl font-bold leading-tight tracking-tight sm:text-6xl">
            La contabilidad de tu despacho, en automático.
          </h1>
          <p className={`mx-auto mt-6 max-w-2xl text-lg leading-relaxed ${SUAVE}`}>
            CFDIs que se descargan solos, bancos que llegan por WhatsApp, nómina verificada contra
            el DOF y toda tu cartera de clientes en un tablero. Tú pones el criterio; el sistema
            pone las horas.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link href="/signup" className={BTN_PRIMARIO}>
              Empieza tu prueba gratis <ArrowRight className="h-4 w-4" />
            </Link>
            <a href={DEMO_MAILTO} className={BTN_SECUNDARIO}>
              Agenda una demo para tu despacho
            </a>
          </div>
          <p className={`mt-4 text-xs ${FAINT}`}>Sin tarjeta. La prueba incluye acceso completo.</p>

          <div className="mt-12 flex flex-wrap items-center justify-center gap-3">
            {CHIPS.map((c) => (
              <span
                key={c}
                className={`rounded-lg border border-white/15 bg-white/[0.05] px-4 py-2 font-mono text-sm ${SUAVE}`}
              >
                {c}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ── Cómo funciona ── */}
      <section className="border-y border-white/10 bg-[#0A1D3A]/60">
        <div className="mx-auto grid max-w-6xl gap-10 px-6 py-16 sm:grid-cols-3">
          {PASOS.map((p) => (
            <div key={p.n}>
              <div className={`font-mono text-sm font-bold ${ACENTO}`}>{p.n}</div>
              <h2 className="mt-2 text-lg font-semibold text-white">{p.title}</h2>
              <p className={`mt-1.5 text-sm leading-relaxed ${SUAVE}`}>{p.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Features ── */}
      <section className="mx-auto max-w-6xl px-6 py-20">
        <h2 className="text-center text-3xl font-bold tracking-tight sm:text-4xl">
          Lo que hoy te come el día, resuelto.
        </h2>
        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className={`${CARD} p-6`}>
              <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-[#8FB8F2]/15 text-[#8FB8F2]">
                <f.icon className="h-5 w-5" />
              </div>
              <h3 className="font-semibold text-white">{f.title}</h3>
              <p className={`mt-2 text-sm leading-relaxed ${SUAVE}`}>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Confianza ── */}
      <section className="border-y border-white/10 bg-[#0A1D3A]/60">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <h2 className="text-center text-3xl font-bold tracking-tight sm:text-4xl">
            Hecho para que puedas confiarle la llave.
          </h2>
          <div className="mt-12 grid gap-5 sm:grid-cols-3">
            {TRUST.map((t) => (
              <div key={t.title} className={`${CARD} p-6`}>
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-[#8FB8F2]/15 text-[#8FB8F2]">
                  <t.icon className="h-5 w-5" />
                </div>
                <h3 className="font-semibold text-white">{t.title}</h3>
                <p className={`mt-2 text-sm leading-relaxed ${SUAVE}`}>{t.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Precios ── */}
      <section className="mx-auto max-w-6xl px-6 py-20">
        <h2 className="text-center text-3xl font-bold tracking-tight sm:text-4xl">Precios simples.</h2>
        <p className={`mx-auto mt-3 max-w-xl text-center text-sm ${SUAVE}`}>
          Por empresa, por mes. El plan anual equivale a 10 meses.
        </p>
        <div className="mx-auto mt-12 grid max-w-4xl gap-5 sm:grid-cols-3">
          <div className={`${CARD} p-6`}>
            <h3 className="font-semibold text-white">Básico</h3>
            <p className="mt-3 text-3xl font-bold text-white">
              $499 <span className={`text-sm font-normal ${FAINT}`}>MXN/mes</span>
            </p>
            <ul className={`mt-5 space-y-2.5 text-sm ${SUAVE}`}>
              {["Sincronización SAT", "Consultas y reportes", "Declaraciones"].map((x) => (
                <li key={x} className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#8FB8F2]" /> {x}
                </li>
              ))}
            </ul>
          </div>
          <div className="relative rounded-2xl border-2 border-[#8FB8F2] bg-white/[0.06] p-6">
            <span className="absolute -top-3 left-6 rounded-full bg-[#8FB8F2] px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#0A1D3A]">
              Recomendado
            </span>
            <h3 className="font-semibold text-white">Profesional</h3>
            <p className="mt-3 text-3xl font-bold text-white">
              $1,299 <span className={`text-sm font-normal ${FAINT}`}>MXN/mes</span>
            </p>
            <ul className={`mt-5 space-y-2.5 text-sm ${SUAVE}`}>
              {[
                "Todo lo de Básico",
                "Asistente IA + WhatsApp",
                "Conciliación bancaria",
                "Complementos de pago",
              ].map((x) => (
                <li key={x} className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#8FB8F2]" /> {x}
                </li>
              ))}
            </ul>
          </div>
          <div className={`${CARD} p-6`}>
            <h3 className="font-semibold text-white">Despachos</h3>
            <p className="mt-3 text-3xl font-bold text-white">A tu medida</p>
            <p className={`mt-5 text-sm leading-relaxed ${SUAVE}`}>
              Multiempresa con precio por volumen según tu cartera. Cuéntanos cuántas empresas
              llevas y armamos tu propuesta.
            </p>
            <a
              href={DEMO_MAILTO}
              className={`mt-5 inline-flex items-center gap-1.5 text-sm font-semibold ${ACENTO} hover:underline`}
            >
              Agenda una demo <ArrowRight className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>
      </section>

      {/* ── CTA final ── */}
      <section className="border-t border-white/10 bg-gradient-to-b from-[#0A1D3A] to-[#0E2A52]">
        <div className="mx-auto max-w-6xl px-6 py-20 text-center">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            La demo se hace con tus propios CFDIs.
          </h2>
          <p className={`mx-auto mt-4 max-w-xl text-sm leading-relaxed ${SUAVE}`}>
            Veinte minutos: conectamos una e.firma, la historia fiscal se importa sola y ves tu
            operación real dentro del sistema. Sin diapositivas.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link href="/signup" className={BTN_PRIMARIO}>
              Crear cuenta <ArrowRight className="h-4 w-4" />
            </Link>
            <a href={DEMO_MAILTO} className={BTN_SECUNDARIO}>
              Escríbenos
            </a>
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-white/10 bg-[#081527]">
        <div className={`mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-6 text-xs ${FAINT}`}>
          <span>
            Contabilidad <span className={ACENTO}>OS</span> — Sistema contable y fiscal mexicano
          </span>
          <span className="flex gap-4">
            <Link href="/legal/aviso-de-privacidad" className="hover:text-white hover:underline">
              Aviso de Privacidad
            </Link>
            <Link href="/legal/terminos" className="hover:text-white hover:underline">
              Términos y Condiciones
            </Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
