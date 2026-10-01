// Regímenes fiscales que se ofrecen al confirmar datos en el alta (mismo
// catálogo que el wizard manual, src/app/onboarding/manual/page.tsx).
export const REGIMENES_ALTA: ReadonlyArray<{ value: string; label: string }> = [
  { value: "601", label: "601 – General de Ley Personas Morales" },
  { value: "603", label: "603 – Personas Morales con Fines no Lucrativos" },
  { value: "605", label: "605 – Sueldos y Salarios e Ingresos Asimilados" },
  { value: "606", label: "606 – Arrendamiento" },
  { value: "607", label: "607 – Enajenación o Adquisición de Bienes" },
  { value: "608", label: "608 – Demás ingresos" },
  { value: "612", label: "612 – Personas Físicas con Actividades Empresariales y Profesionales" },
  { value: "616", label: "616 – Sin obligaciones fiscales" },
  { value: "620", label: "620 – Sociedades Cooperativas de Producción" },
  { value: "621", label: "621 – Incorporación Fiscal" },
  { value: "622", label: "622 – Actividades Agrícolas, Ganaderas, Silvícolas y Pesqueras" },
  { value: "625", label: "625 – Plataformas Tecnológicas" },
  { value: "626", label: "626 – Régimen Simplificado de Confianza (RESICO)" },
];
