// Verifica el motor de cambios de cumplimiento. Run: npm run fiscal:cumplimiento-check

import {
  evaluarCambioCumplimiento,
  hashContenido,
  type CsfResult,
  type OpinionResult,
} from "../src/lib/fiscal/cumplimiento";

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (!cond) fallos++;
  console.log(`  ${cond ? "✓" : "✗"} ${nombre}${!cond && detalle ? ` — ${detalle}` : ""}`);
}

const NOW = "2026-06-13T00:00:00Z";
const opinion = (resultado: OpinionResult["resultado"], motivos: string[] = []): OpinionResult => ({
  tipo: "SAT_OPINION",
  resultado,
  motivos,
  fetchedAt: NOW,
});
const csf = (perfil: Partial<CsfResult["perfil"]>): CsfResult => ({
  tipo: "CSF",
  perfil: {
    rfc: "ABC120101AAA",
    regimenes: ["601"],
    obligaciones: ["ISR mensual", "IVA mensual"],
    codigoPostal: "44100",
    estatusPadron: "ACTIVO",
    ...perfil,
  },
  fetchedAt: NOW,
});

console.log("opinión SAT/IMSS");
const hNeg = evaluarCambioCumplimiento(opinion("NEGATIVA", ["ISR mayo 2026 no presentada"]), null);
check("negativa → 1 hallazgo error", hNeg.length === 1 && hNeg[0].severidad === "error");
check("negativa cita motivos", /ISR mayo 2026/.test(hNeg[0].mensaje));
check("negativa cita CFF 32-D", hNeg[0].fundamento.articulo === "32-D");

const hTrans = evaluarCambioCumplimiento(opinion("NEGATIVA"), opinion("POSITIVA"));
check("transición POSITIVA→NEGATIVA marcada", /cambió de POSITIVA a NEGATIVA/.test(hTrans[0].mensaje));

const hReg = evaluarCambioCumplimiento(opinion("POSITIVA"), opinion("NEGATIVA"));
check("regularización → info (no error)", hReg.length === 1 && hReg[0].severidad === "info");

check("positiva sin cambio → sin hallazgo", evaluarCambioCumplimiento(opinion("POSITIVA"), opinion("POSITIVA")).length === 0);
check("primera captura positiva → sin hallazgo", evaluarCambioCumplimiento(opinion("POSITIVA"), null).length === 0);

console.log("CSF");
const hSusp = evaluarCambioCumplimiento(csf({ estatusPadron: "SUSPENDIDO" }), null);
check("RFC suspendido → error", hSusp.some((h) => h.checkClave === "cumplimiento.csf.estatus" && h.severidad === "error"));

const hObl = evaluarCambioCumplimiento(
  csf({ obligaciones: ["ISR mensual", "IVA mensual", "DIOT"] }),
  csf({}),
);
check("nueva obligación detectada", hObl.some((h) => h.checkClave === "cumplimiento.csf.obligaciones" && /DIOT/.test(h.mensaje)));

const hReg2 = evaluarCambioCumplimiento(csf({ regimenes: ["626"] }), csf({ regimenes: ["601"] }));
check("cambio de régimen detectado", hReg2.some((h) => h.checkClave === "cumplimiento.csf.regimen"));

const hDom = evaluarCambioCumplimiento(csf({ codigoPostal: "64000" }), csf({ codigoPostal: "44100" }));
check("cambio de domicilio detectado", hDom.some((h) => h.checkClave === "cumplimiento.csf.domicilio"));

check("CSF sin cambios → sin hallazgo", evaluarCambioCumplimiento(csf({}), csf({})).length === 0);

console.log("hashContenido");
check("hash estable ante mismo contenido", hashContenido(csf({})) === hashContenido(csf({})));
check("hash cambia con el contenido", hashContenido(csf({ obligaciones: ["X"] })) !== hashContenido(csf({})));
check("orden de obligaciones no afecta el hash", hashContenido(csf({ obligaciones: ["A", "B"] })) === hashContenido(csf({ obligaciones: ["B", "A"] })));

console.log("");
if (fallos === 0) {
  console.log("All checks passed.");
  process.exit(0);
} else {
  console.error(`${fallos} check(s) FAILED.`);
  process.exit(1);
}
