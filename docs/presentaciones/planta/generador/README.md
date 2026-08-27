# Generador de las pantallas y el deck de la planta

Las capturas de `../capturas/` y el `../planta-agua.pptx` no son maquetas
dibujadas a mano: salen de este generador. Corregir un dato, un precio o la
marca es editar una constante y volver a correr tres comandos — no rehacer
nada en un editor de imágenes.

## Requisitos

Node ≥ 20. Dentro de este directorio:

```bash
npm init -y && npm install pptxgenjs playwright
npx playwright install chromium   # o exporta CHROMIUM_PATH a uno ya instalado
```

Para el QA geométrico (opcional): `pip install python-pptx`.

## Regenerar todo

```bash
node planta/gen.js                     # HTML de las 8 pantallas → planta/html/
node planta/shoot.js                   # capturas 1600×920 @2x → planta/png/
cp planta/png/*.png ../capturas/       # publica las capturas
node build-planta.js ../planta-agua.pptx   # arma el deck de 15 láminas
python3 qa.py ../planta-agua.pptx      # QA: desbordes, márgenes, encimados
```

## Qué tocar cuando haya marca real

Hoy todo usa el placeholder **«Planta purificadora»** y una paleta propia de
agua. Con el nombre y los colores del cliente:

| Qué | Dónde |
|---|---|
| Paleta de las pantallas | `planta/base.css`, variables `--…` al inicio (azules `#0C3D55`/`#2E6E8E`, acento aqua `#0E93B8`) |
| Logo del rail (hoy: icono de gota) | `planta/gen.js`, helper `rail` |
| Nombre en portada, pies de lámina y cierre | `build-planta.js`, buscar `"Planta purificadora"` |
| Precio de la lámina de inversión | `build-planta.js`, buscar `"$12,000"` |
| Colores del deck | `build-planta.js`, objeto `C` al inicio |

## El caso continuo

Los números están amarrados **entre** pantallas: la pipa P-0847 (20,000 L), el
lote L-0824-M (910×20 L + 70×19 L = 19,530 L, merma 470 L), la remisión R-1042
(400 llenos, 380 vacíos → saldo +340) y el estado de cuenta de agosto
(8,400 garrafones × $14.50 = $121,800, PPD, IVA 0%). Si se edita una cifra en
una pantalla, hay que propagarla a las demás — el balance de masa que cuadra
*es* el argumento de la presentación.
