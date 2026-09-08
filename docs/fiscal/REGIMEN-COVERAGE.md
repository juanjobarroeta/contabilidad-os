# Mexican tax-regime coverage tracker

Status date: 2026-09-08
Product scope: current CFDI 4.0 regime codes accepted by ContabilidadOS
Legal baseline: SAT/RMF 2026; taxpayer-specific CSF obligations remain authoritative

## What “support” means

Catalog recognition is not calculation support. Every regime track is scored separately for:

1. `CAT`: recognized in onboarding, CSF parsing, invoicing, and validation.
2. `CAL`: taxpayer-specific obligation calendar and due dates.
3. `MON`: monthly/bimonthly ISR and IVA workpapers.
4. `ANN`: annual ISR composition and workpaper.
5. `ACC`: accounting behavior and regime-specific adjustments.
6. `FILE`: staged filing and acuse reconciliation.
7. `QA`: versioned official sources, golden cases, and external professional sign-off.

Status values:

- `FULL`: all promised scenarios pass the seven dimensions.
- `PARTIAL`: usable components exist, but the track is not safe to advertise as complete.
- `ASSISTED`: calendar, documents, and accounting may be used; calculation requires accountant-entered figures.
- `BLOCK`: the current generic fallback can produce a wrong result and must be disabled.
- `NO-CALC`: deliberately no calculation for this code/scenario.

## Current coverage audit

There are 19 current product catalog codes and 20 calculation tracks because code 626 must be split into PF and PM. `REGIMEN_MAP` currently contains only 16 codes: 607, 615, and 625 are recognized by parsers but absent from the default obligation map.

| Code / track | Taxpayer | Current state | Required target | Phase | Main missing work |
|---|---|---|---|---|---|
| 601 General de Ley | PM | PARTIAL | FULL | 1 | Validate Art. 14, coefficient history, PTU/losses, annual adjustments, DIOT, and cross-screen reconciliation |
| 603 Fines no Lucrativos | PM | BLOCK | ASSISTED → FULL | 5 | Remove Art. 14/30% fallback; remanente distribuible, donataria/non-donataria rules, retentions, IVA, informatives, and February annual deadline |
| 605 Sueldos/Asimilados | PF | BLOCK | NO-CALC + ANN composition | 1/5 | A 605 taxpayer is not automatically a payroll withholding employer; remove phantom monthly retention and PF-business fallback; model conditional annual filing |
| 606 Arrendamiento | PF | PARTIAL | FULL | 1 | Proven deductions vs 35% option, per-property data, quarterly option where applicable, annual composition, mixed regimes |
| 607 Enajenación/Adquisición | PF | BLOCK | ASSISTED → FULL | 5 | Missing obligation map; event-specific provisional/final payments, notarial retentions, acquisition vs disposition, annual composition |
| 608 Demás Ingresos | PF | BLOCK | ASSISTED → FULL | 5 | Chapter-specific event/provisional rules and annual composition; generic Art. 106 formula is unsafe |
| 610 Extranjero sin EP | PF/PM foreign | BLOCK | ASSISTED | 5 | Source-of-income and treaty/withholding scenarios; foreign identity; payer vs recipient role; no generic domestic formula |
| 611 Dividendos | PF | BLOCK | ANN composition | 5 | Corporate gross-up/credit, 10% additional withholding where applicable, foreign dividends, CUFIN evidence |
| 612 Actividad Empresarial/Profesional | PF | PARTIAL | FULL | 1 | Finish cash-basis evidence, investments, losses, retentions, annual composition, mixed regimes, golden cases |
| 614 Intereses | PF | BLOCK | ANN composition | 5 | Real vs nominal interest, withholding, losses and annual aggregation; generic PF-business formula is unsafe |
| 615 Premios | PF | BLOCK | ANN/event composition | 5 | Missing obligation map; federal/state withholding and annual information treatment |
| 616 Sin Obligaciones | PF | BLOCK | NO-CALC | 0 | Taxes must show “not applicable”; never run the PF-business fallback |
| 620 Cooperativas de Producción | PM | BLOCK | ASSISTED/partner → FULL | 5 | Member-level profit, annual-only option, deferral until distribution, CUFIN-equivalent records; current Art. 14 fallback is unsafe |
| 621 RIF | PF legacy | BLOCK | ASSISTED → FULL if demand | 5 | Calendar exists, but no bimonthly ISR/IVA engine, transition-year reductions, IEPS/IVA stimuli, or remaining-tenure validation |
| 622 AGAPES | PM and qualifying structures | PARTIAL components, unsafe integration | ASSISTED → FULL | 5 | Existing exemption/reduction/facility helpers are not integrated; member rules, thresholds, provisional/annual mechanics, IVA/DIOT |
| 623 Grupos de Sociedades | PM group | BLOCK | Partner-assisted | 5 | Integrator/integrated entities, authorization, integrated result factor, deferred ISR ledger, incorporations/desincorporations |
| 624 Coordinados | PM/member structure | PARTIAL components, unsafe integration | Partner-assisted → FULL if demand | 5 | Member-level obligations, settlements, transport facilities, deductions, retentions; generic PM formula is unsafe |
| 625 Plataformas Tecnológicas | PF | PARTIAL | FULL | 1 | Missing obligation map; definitive vs provisional election, MXN300k condition, direct collections, mixed activities, IVA and DIOT relief |
| 626 RESICO | PF | PARTIAL | FULL | 1 | True collected-income basis for PUE/PPD/REP, mixed-income annual rules, eligibility/exit, 1.25% retention, annual/DIOT/CE relief by effective rule |
| 626 RESICO | PM | BLOCK | FULL | 1 | Build a separate cumulative cash-basis income-minus-paid-deductions engine; current Art. 14 coefficient fallback is incorrect for this track |

## Launch boundary

The initial commercial promise should cover only these six tracks:

1. 601 PM General.
2. 612 PF Business/Professional.
3. 606 PF Rental.
4. 625 PF Technology Platforms.
5. 626 RESICO PF.
6. 626 RESICO PM.

All other codes remain available for document storage, CFDI/accounting workflows, and an accurate obligation calendar only when that capability is verified. The UI must say `Assisted by your accountant` instead of presenting a calculated amount.

## Cross-regime requirements

A correct engine cannot branch only on one primary code. It must carry separate tax baskets and then compose them where the law requires it.

| Dimension | Examples | Required behavior |
|---|---|---|
| Multiple active regimes | 626 + 605/614; 612 + 606; 611 + 614 | Keep monthly bases separate; compose annual income, credits, and deductions explicitly |
| Taxpayer type | 626 PF vs 626 PM | Separate engines and obligations despite sharing a catalog code |
| Taxpayer role | 605 employee vs employer; 610 payer vs foreign recipient | Obligations derive from facts/CSF, not from the income code alone |
| Elections/options | 606 deductions; 625 definitive treatment; RIF transition | Store effective date, evidence, and reviewer; never infer silently |
| Cash basis | 606, 612, 625, 626 | Resolve PUE and PPD/REP collections/payments by period |
| Geography | Northern/southern border stimulus; local payroll tax | Versioned rules by location and effective date |
| Sector/activity | AGAPES, transport/coordinados, IEPS activities | Activity-specific rules supplement—not replace—the regime code |
| Employer status | Payroll, IMSS, INFONAVIT, state payroll tax | Data-driven obligations independent of the taxpayer’s income regime |
| Filing history | balances, losses, coefficient, credits | Imported acuses and prior returns are required inputs with confidence/provenance |

## Definition of FULL for one track

- [ ] Official legal sources and effective dates stored.
- [ ] Accepted taxpayer types and incompatible combinations encoded.
- [ ] CSF obligation descriptions mapped and reviewed.
- [ ] Monthly/bimonthly calendar and deadline rules tested.
- [ ] ISR engine covers zero, taxable, refund/credit, retention, and prior-period cases.
- [ ] IVA handles cash basis, PUE/PPD/REP, retentions, exempt/zero/non-object acts, proportion, and balances.
- [ ] DIOT applicability and relief are explicit.
- [ ] Annual inclusion/exemption and composition are explicit.
- [ ] Accounting entries and financial-statement effects tie to the workpaper.
- [ ] Unsupported options return `NOT_SUPPORTED`, never a substitute formula.
- [ ] At least 20 anonymized golden cases reviewed by a licensed Mexican tax professional.
- [ ] Production calculation is reconciled to an acuse and variance is recorded.

## Official baseline sources

- [SAT fiscal-regime catalog](https://www.cloudb.sat.gob.mx/datos_fiscales/regimen)
- [SAT individual taxpayer regimes](https://sat.gob.mx/portal/public/personas-fisicas)
- [SAT 2026 RMF and annexes](https://www.sat.gob.mx/minisitio/NormatividadRMFyRGCE/index.html)
- [SAT annual filing deadlines by PM regime](https://www.sat.gob.mx/minisitio/DeclaracionAnual/Empresas/quienes_deben_presentarla.html)
- [SAT monthly filing and RFC-digit extension guidance](https://wwwmat.sat.gob.mx/declaracion/95291/declaracion-mensual-para-tu-empresa-en-el-servicio-de-declaraciones-y-pagos)
- [Current Código Fiscal de la Federación, Article 12](https://www.diputados.gob.mx/LeyesBiblio/pdf/CFF.pdf)
- [SAT RESICO PF portal](https://wwwnp.sat.gob.mx/portal/public/personas-fisicas/pf-simplificado-de-confianza)
- [SAT RESICO PM monthly filing](https://wwwmat.sat.gob.mx/declaracion/46610/simulador-de-declaraciones-de-pagos-provisionales-y-definitivos)
- [SAT PM annual filing for RESICO](https://wwwmat.sat.gob.mx/declaracion/36349/presenta-tu-declaracion-anual-personas-morales.-regimen-simplificado-de-confianza)
- [SAT 2026 annual guidance for individuals](https://www.sat.gob.mx/minisitio/DeclaracionAnual/Personas/quienes_deben_presentarla.html)

This tracker is a product-engineering control, not individualized tax advice. Each taxpayer’s current CSF, elections, activities, geography, and filing history can change the result.
