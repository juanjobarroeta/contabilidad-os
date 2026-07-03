# Ventanilla Digital Tlaxcala — maqueta navegable

Maqueta conceptual (mock) de la plataforma unificada de trámites para el Gobierno del Estado de Tlaxcala, alineada al brief estratégico (LNETB, Llave MX, Expediente Digital, Catálogo Único, plazo 30-nov-2026).

**Todo es ficticio e ilustrativo**: trámites, montos, plazos, personas y folios. No es un sitio oficial.

## Cómo verla

Es un solo archivo estático, sin dependencias ni build:

```
open demos/tlaxcala-ventanilla/index.html
```

o servirla con cualquier estático (`npx serve demos/tlaxcala-ventanilla`).

## Qué demuestra

| Escena | Ruta | Punto del pitch |
|---|---|---|
| Portal único ciudadano | `#/inicio` | Una sola puerta de entrada (vs. 6 sistemas fragmentados) |
| Catálogo de trámites | `#/catalogo` | Fichas ingeridas del RESTS, conformes al Catálogo Único |
| Identidad Llave MX | botón «Llave MX» | Federación OIDC simulada; sin cuentas nuevas |
| Trámite con resolución | `#/tramite/lic-construccion` | Flujo adjudicado end-to-end (hito federal de construcción) |
| Pago en línea | wizard, paso 3 | Reutiliza la infraestructura de pagos de SEFIN: tarjeta, CoDi, línea de captura |
| Expediente Digital | `#/expediente` | «No pedir dos veces»: documentos verificados y reutilizables |
| Seguimiento | `#/mis-tramites` | Estatus en tiempo real, resoluciones con sello digital |
| Consola de dependencias | `#/funcionarios` | Back office: bandeja, SLA, dictamen, bitácora de auditoría |
| Trámite = configuración | `#/funcionarios-config` | Motor multi-tenant impulsado por metadatos (replicable a otros estados) |

El botón flotante **▸ Demo** (abajo a la derecha) contiene el guion de demostración con acceso directo a cada escena, en el orden sugerido para presentarla.
