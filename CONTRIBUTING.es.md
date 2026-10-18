# Como contribuir

[English](CONTRIBUTING.md) | **Espanol**

Gracias por tomarte el tiempo de mejorar este plugin. Corre dentro de cada request de
modelo de una sesion de OpenCode, asi que el estandar para cualquier cambio es:
predecible, fail-open y testeable sin red.

## Setup

```bash
git clone git@github.com:JoshRob297/opencode-commandcode.git
cd opencode-commandcode
bun install
bun test          # suite offline, sin red, sin consumir cuota
bun run typecheck # tsc estricto, sin emit
```

La suite con red es opt-in y llama a la API real (consume una cantidad insignificante
de cuota):

```bash
COMMANDCODE_LIVE_TESTS=1 bun test
```

## Reglas de base

No son preferencias de estilo: protegen las garantias del plugin. Un cambio que rompa
alguna vuelve atras.

1. **Fail-open.** Cualquier error del plugin debe dejar el request original intacto.
   Nunca dejes que un hook lance una excepcion hacia la sesion de OpenCode.
2. **Credenciales solo tras coincidencia exacta de host.** Nunca introduzcas una
   verificacion por substring, prefijo o path en la ruta de inyeccion. Los hosts
   confiables nuevos entran por `COMMANDCODE_ALLOWED_HOSTS`.
3. **Nunca sobrescribas la cabecera `authorization` de un llamador.**
4. **Sin secretos en los logs.** El plugin escribe ids de sesion, ids de modelo, codigos
   de estado y mensajes de error. Nunca cuerpos, cabeceras ni la key.
5. **Exactitud del catalogo antes que tamano.** No registres modelos que el transporte
   compatible con OpenAI no puede servir. Un modelo que falla al seleccionarlo es peor
   que un modelo ausente.
6. **Sin rutas de usuario hardcodeadas.** Usa `XDG` y `os.homedir()`; los tests deben
   pasar para cualquier usuario.
7. **Los helpers puros siguen siendo puros.** `src/hooks/resilience.ts` no tiene acceso
   a red y solo hace una revision de filesystem (el centinela del kill-switch), para que
   sus reglas se puedan testear en aislamiento.
8. **Reconstrui el Request solo cuando el cuerpo haya cambiado realmente.** Devolve
   `modified: false` para payloads limpios.

## Mensajes de commit

Conventional Commits, imperativo, asunto en minusculas:

```
<tipo>(<alcance>): <asunto>

<cuerpo: que y por que, con lineas de 72 columnas>

<pie: refs, cambios incompatibles>
```

Tipos: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `security`.
Alcances: `auth`, `catalog`, `sanitizer`, `watchdog`, `quota`, `telemetry`, `docs`.

Ejemplos:

```
fix(auth): require an exact hostname match before injecting the API key
feat(catalog): tag free and promo tiers in the model selector
docs(troubleshooting): document the retired free-tier 403 payload
```

Mantene los commits atomicos: un cambio logico mas sus tests. Cada commit debe pasar
`bun test` y `bun run typecheck`.

## Pull requests

- Completa la plantilla de pull request. Indica el modo de fallo que observaste, no solo
  el cambio que hiciste.
- Agrega o actualiza tests. Los fixes de bugs necesitan un test de regresion que falle
  antes del fix.
- Actualiza `CHANGELOG.md` bajo `## [Unreleased]`.
- La documentacion vive en dos idiomas: `README.md` + `docs/*.md` (ingles) y
  `README.es.md` + `docs/es/*.md` (espanol), mas los archivos de comunidad traducidos
  (`docs/es/code-of-conduct.md`, `SECURITY.es.md`, `CONTRIBUTING.es.md`). Los cambios de
  comportamiento deben reflejarse en ambos, o decilo explicitamente en el PR para que
  quede registrado.

## Agregar un hook o una regla nueva

1. Pone la logica pura en `src/hooks/resilience.ts` y exportala.
2. Testeala en `tests/` (sin red, sin instancia de OpenCode).
3. Documenta la regla en `docs/ARCHITECTURE.md` (tabla de reglas) y, si es configurable,
   en `docs/CONFIGURATION.md`.
4. Cableala en `src/index.ts` detras de una verificacion de capacidad
   (`typeof ctx.x?.transform === "function"`) y envuelta para que no pueda lanzar.

## Reportar bugs

Abre un issue con la plantilla de bug report. Incluye la version de OpenCode, el commit
del plugin, el id del modelo, y las lineas relevantes de
`<state>/commandcode-*.log`. Nunca pegues una API key en un issue.
