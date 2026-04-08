/**
 * Landing page for users whose account doesn't have CONTABILIDAD access.
 *
 * Reached via a redirect from (app)/layout.tsx when a logged-in user has
 * no CompanyMember or DespachoMember that grants them CONTABILIDAD on any
 * company. Typical case: a construction-only user (restricted
 * allowedModules = ['CONSTRUCCION']) tries to open contabilidad-os.
 *
 * This page is OUTSIDE the (app) route group on purpose — it doesn't
 * run the layout guard, so the user can land here without a redirect loop.
 *
 * Intentionally minimal and styled with inline Tailwind because it's a
 * dead-end UX — the user is supposed to leave.
 */

import Link from "next/link";

const BARTIZ_URL =
  process.env.NEXT_PUBLIC_BARTIZ_URL ?? "https://bartiz.vercel.app";

export default function AccesoRestringidoPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 to-slate-800 p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-8">
        <div className="text-4xl mb-4">🏗️</div>
        <h1 className="text-2xl font-bold text-slate-900 mb-3">
          Tu cuenta es solo para Bartiz
        </h1>
        <p className="text-slate-600 mb-6 leading-relaxed">
          Esta cuenta tiene acceso exclusivo al módulo de construcción.
          Para entrar, usa Bartiz en lugar de contabilidad-os.
        </p>
        <a
          href={BARTIZ_URL}
          className="block w-full text-center bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-lg transition-colors"
        >
          Ir a Bartiz →
        </a>
        <Link
          href="/login"
          className="block w-full text-center text-slate-500 hover:text-slate-700 mt-4 text-sm"
        >
          Cambiar de cuenta
        </Link>
      </div>
    </div>
  );
}
