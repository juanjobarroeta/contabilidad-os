#!/usr/bin/env python3
# Genera la guía de alta de 1 página para un piloto (docs/onboarding/...).
# Sin dependencias — sólo stdlib, fuentes Helvetica del core PDF.
#   python3 scripts/onboarding-guide-pdf.py
import zlib  # stdlib, safe

W, H = 612, 792
LEFT, RIGHT = 50, 562
USABLE = RIGHT - LEFT
BLUE = (0.145, 0.388, 0.922)     # #2563EB
DARK = (0.13, 0.16, 0.20)        # near-black slate
GRAY = (0.40, 0.45, 0.52)
LIGHT = (0.93, 0.95, 0.99)       # soft tint band

ops = []  # content stream pieces


def esc(s):
    return s.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


def text(x, y, s, size, font="F1", color=DARK):
    r, g, b = color
    ops.append(f"BT /{font} {size} Tf {r:.3f} {g:.3f} {b:.3f} rg "
               f"1 0 0 1 {x:.1f} {y:.1f} Tm ({esc(s)}) Tj ET")


def rect(x, y, w, h, color, fill=True):
    r, g, b = color
    if fill:
        ops.append(f"{r:.3f} {g:.3f} {b:.3f} rg {x:.1f} {y:.1f} {w:.1f} {h:.1f} re f")
    else:
        ops.append(f"{r:.3f} {g:.3f} {b:.3f} RG 1 w {x:.1f} {y:.1f} {w:.1f} {h:.1f} re S")


def wrap(s, size, maxw):
    max_chars = int(maxw / (0.49 * size))
    words, lines, cur = s.split(), [], ""
    for w in words:
        if len(cur) + len(w) + 1 <= max_chars:
            cur = (cur + " " + w).strip()
        else:
            lines.append(cur); cur = w
    if cur:
        lines.append(cur)
    return lines


class Cur:
    y = H - 110


def heading(s):
    Cur.y -= 6
    text(LEFT, Cur.y, s, 12.5, font="F2", color=BLUE)
    Cur.y -= 17


def para(s, size=10.5, color=DARK, indent=0, lead=13):
    for ln in wrap(s, size, USABLE - indent):
        text(LEFT + indent, Cur.y, ln, size, color=color)
        Cur.y -= lead


def bullet(s, size=10.5, color=DARK):
    text(LEFT + 4, Cur.y, "•", size, font="F2", color=BLUE)
    first = True
    for ln in wrap(s, size, USABLE - 18):
        text(LEFT + 18, Cur.y, ln, size, color=color)
        Cur.y -= 13
        first = False


def check(s, size=10.5):
    box = 9
    rect(LEFT + 2, Cur.y - 1, box, box, GRAY, fill=False)
    for i, ln in enumerate(wrap(s, size, USABLE - 22)):
        text(LEFT + 18, Cur.y, ln, size, color=DARK)
        Cur.y -= 14


def spacer(h=8):
    Cur.y -= h


# ── Header band ──────────────────────────────────────────────────────────────
rect(0, H - 86, W, 86, BLUE)
text(LEFT, H - 42, "Antes de empezar  ·  Alta de tu empresa", 19, font="F2",
     color=(1, 1, 1))
text(LEFT, H - 64, "People HCS en ContabilidadOS  ·  guía rápida (~10 min)", 11,
     color=(0.90, 0.94, 1.0))

# ── 1. Qué necesitas a la mano ───────────────────────────────────────────────
heading("1. Ten esto a la mano antes de empezar")
check("e.firma (FIEL): archivo .cer")
check("e.firma (FIEL): archivo .key")
check("Contraseña de la e.firma")
check("Constancia de Situación Fiscal (CSF) en PDF — descárgala del SAT, que sea reciente")
check("Solo si vas a facturar: CSD (.cer, .key y su contraseña) — es distinto de la e.firma")
spacer(6)

# ── 2. Dónde encuentro cada archivo ────────────────────────────────────────
heading("2. Dónde encuentro cada cosa")
bullet("e.firma .cer y .key: son los archivos que te entregó el SAT cuando tramitaste tu "
       "e.firma (suelen estar en una USB o carpeta). Si no los ubicas, agéndala en el SAT.")
bullet("CSF: en sat.gob.mx busca “Genera tu Constancia de Situación Fiscal”. Entras con tu "
       "e.firma o con RFC + contraseña, y descargas el PDF.")
bullet("CSD: son los archivos del Certificado de Sello Digital (para timbrar facturas). "
       "No los confundas con la e.firma. Si aún no facturas, pásalo — lo subes después.")
spacer(6)

# ── 3. Cómo es el proceso ───────────────────────────────────────────────────
heading("3. Cómo es el proceso (te guía paso a paso)")
para("Inicia sesión con el correo y la contraseña temporal que te compartieron, y sigue el "
     "asistente. En resumen:", lead=13)
spacer(2)
bullet("Sube tus documentos (CSF y los que tengas): la IA lee y llena los datos sola.")
bullet("Revisa que los datos estén bien y confirma.")
bullet("Cuando pregunte la sincronización, elige “Últimos 5 años” (lo recomendado).")
bullet("Al final, sube tu e.firma (.cer, .key y contraseña). Eso arranca la descarga del SAT.")
spacer(6)

# ── 4. Tranquilidad ──────────────────────────────────────────────────────────
rect(LEFT - 8, Cur.y - 64, USABLE + 16, 78, LIGHT)
heading("4. Para tu tranquilidad")
bullet("Tu e.firma se guarda CIFRADA y solo se usa para descargar tus facturas del SAT. "
       "Nunca se comparte con nadie.")
bullet("La descarga de 5 años tarda horas (a veces 1–2 días). Es normal: puedes cerrar la "
       "página, sigue corriendo sola. Tus facturas y declaraciones aparecerán por su cuenta.")
spacer(10)

text(LEFT, Cur.y, "¿Te atoras en algo? Mejor escríbeme antes de adivinar — lo resolvemos en 2 minutos.",
     10, font="F2", color=BLUE)

# ── Assemble PDF ─────────────────────────────────────────────────────────────
stream = "\n".join(ops).encode("cp1252")
comp = zlib.compress(stream)

objs = []
objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
objs.append(b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
objs.append(("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] "
             "/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> "
             "/Contents 4 0 R >>" % (W, H)).encode())
objs.append(b"<< /Length %d /Filter /FlateDecode >>\nstream\n" % len(comp)
            + comp + b"\nendstream")
objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica "
            b"/Encoding /WinAnsiEncoding >>")
objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold "
            b"/Encoding /WinAnsiEncoding >>")

out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
offsets = []
for i, o in enumerate(objs, 1):
    offsets.append(len(out))
    out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
xref = len(out)
out += b"xref\n0 %d\n" % (len(objs) + 1)
out += b"0000000000 65535 f \n"
for off in offsets:
    out += b"%010d 00000 n \n" % off
out += (b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n"
        % (len(objs) + 1, xref))

with open("/home/user/contabilidad-os/docs/onboarding/guia-alta-people-hcs.pdf", "wb") as f:
    f.write(out)
print("wrote", len(out), "bytes")
