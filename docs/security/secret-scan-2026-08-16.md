# Escaneo de secretos — historial completo

**Fecha:** 2026-08-16
**Herramienta:** gitleaks v8.24.3, reglas default
**Alcance:** todo el historial de git (`gitleaks git`, todas las ramas locales)
**Comando:**

```sh
gitleaks git --redact -v --report-format json --report-path gitleaks-report.json .
```

## Resultado

**Limpio. 1,154 commits escaneados (~23.6 MB), 0 hallazgos.**

No hay credenciales en el historial del repo con las reglas default de gitleaks
(AWS, claves privadas, tokens de API conocidos, entropía alta, etc.).

## Qué queda vigente a partir de hoy

- **Hook local** (`lefthook.yml`): `gitleaks git --pre-commit --staged` corre en
  cada commit. Si el binario no está instalado, avisa fuerte y deja pasar — el
  bloqueo garantizado es el de CI. Instalar local: `brew install gitleaks`, o
  sin Homebrew, el binario de github.com/gitleaks/gitleaks/releases a un dir
  del PATH (en la máquina de desarrollo actual quedó en
  `~/.npm-global/bin/gitleaks`, v8.24.3, 2026-08-16 — actualizarlo es manual).
- **CI** (`.github/workflows/test.yml`, job `secrets`): escanea el historial
  completo en cada PR y push a main. Este no se puede saltar.
- **Pendiente (ajuste de GitHub, solo el owner puede):** activar *push
  protection* y *secret scanning* en Settings → Code security. El escaneo de
  GitHub cubre patrones de proveedores que las reglas locales no conocen.

## Verificación realizada

Un commit con una llave formato AWS (`AKIA` + 16 chars) fue bloqueado por el
hook local (exit 1, commit no creado). La regla de gitleaks que disparó:
`aws-access-token`.

## Regla permanente

Cualquier secreto real que algún día aparezca en el historial se **rota**, no
solo se borra: purgar el commit no alcanza — hay que asumir que ya fue scrapeado.
