# opencode-commandcode

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[English](README.md) | **Espanol**

Plugin de nivel produccion para [OpenCode](https://opencode.ai) con el proveedor
[Command Code](https://commandcode.ai).

Hace cuatro cosas:

1. **Descubrimiento dinamico de modelos** - registra cada modelo de Command Code que
   el transporte compatible con OpenAI realmente puede servir, y etiqueta los tiers
   gratuitos o promocionales.
2. **Resolucion de credenciales** - encuentra tu API key automaticamente, en cuatro
   almacenes distintos, y la inyecta solo para el origen real de Command Code.
3. **Estabilidad de sesion** - repara los payloads que Command Code rechaza con
   HTTP 400, y aborta los streams SSE que se caen en silencio antes de que congelen
   la interfaz.
4. **Telemetria de cuota** - herramienta `commandcode_quota` y comando
   `/commandcode-quota` para balance y ventanas de rate limit.

> [!NOTE]
> **Estado: desarrollo privado.** El plugin esta verificado contra OpenCode
> **v2.0.32** y Command Code **1.73.4** sobre Bun 1.4.0. Todavia no esta publicado
> en ningun registro; se instala desde este repositorio.

---

## Caracteristicas

### Descubrimiento dinamico de modelos

Command Code expone alrededor de 90 modelos y rota los tiers gratuitos con
frecuencia, por lo que una lista escrita a mano en `opencode.json` queda obsoleta
sola. Al arrancar, el plugin consulta `/provider/v1/models` y registra el catalogo
mediante el editor de modelos de OpenCode v2:

- **Filtrado por transporte.** Solo se registran los modelos que anuncian
  `/chat/completions`. La linea `claude-*` es de forma Anthropic (solo `/messages`) y
  responde `HTTP 400 unsupported_model` en el endpoint compatible con OpenAI, por eso
  se omite en lugar de ofrecerse como opcion rota.
- **Etiqueta automatica de promociones.** Los tiers gratuitos se renombran con el
  sufijo `[FREE PROMO]` para que sean evidentes en el selector `/model`. La deteccion
  cubre ids `:free`, `-free`, `_free`, `.free` y las palabras `free` / `promo` /
  `trial` en el nombre visible.
- **Ventana de contexto real** por modelo, y los modelos multimodales declaran entrada
  `image`.
- **Funciona sin red.** El catalogo se cachea en disco (TTL 6h). Si Command Code esta
  caido o no hay red, OpenCode arranca igual con el ultimo catalogo bueno en lugar de
  quedarse con el proveedor vacio.

### Resolucion de credenciales

Gana la primera coincidencia; todas las rutas son relativas al home (sin rutas de
usuario hardcodeadas):

| Orden | Origen |
| --- | --- |
| 1 | Variable de entorno `COMMAND_CODE_API_KEY` |
| 2 | Override explicito de archivo `COMMANDCODE_KEY_FILE` |
| 3 | `$XDG_CONFIG_HOME/commandcode/key.txt` (por defecto `~/.config/commandcode/key.txt`) |
| 4 | `/etc/environment` -> `COMMAND_CODE_API_KEY` |
| 5 | `~/.commandcode/auth.json` (almacen del CLI oficial) |
| 6 | `~/.commandcode/credentials.json`, luego `~/.commandcode/config.json` |

La key se inyecta como `Authorization: Bearer <key>` **solo cuando el hostname
parseado de la URL es exactamente `api.commandcode.ai`** (o un host autorizado de
forma explicita con `COMMANDCODE_ALLOWED_HOSTS`). Nunca se usa coincidencia por
substring para credenciales: filtraria la key a hosts parecidos como
`api.commandcode.ai.evil.com` o a cualquier servidor que solo lleve
`/provider/v1/chat/completions` en su URL. Una cabecera `authorization` existente
jamas se sobrescribe.

### Rotacion multi-key (opt-in)

Se pueden agrupar varias keys de Command Code para que una cuenta muerta no corte
el turno. Dos o mas keys activan la rotacion; con una sola se mantiene el camino
de key unica sin cambios.

```sh
# inline
export COMMANDCODE_API_KEYS="key_one,key_two"

# o archivo, una por linea (`label=key` o key pelada, comentarios con `#`)
export COMMANDCODE_KEYS_FILE="$HOME/.config/commandcode/keys.txt"
```

Los cooldowns se registran por key segun la respuesta que culpa a la credencial:
`402` (creditos insuficientes) y `401`/`403` bloquean 24h, `429` respeta
`Retry-After` hasta 6h (5m por defecto), y `5xx` nunca culpa a la key. Si todas
estan en cooldown gana la que se recupera antes. El estado guarda solo etiquetas
(`<state>/commandcode-keys-state.json`, modo 0600) y cada cooldown se registra en
`<state>/commandcode-rotation.log`.
| `<state>/commandcode-errors.log` | Fallos decorados: status, codigo upstream, mensaje y la pista mostrada al usuario |

En modo rotacion el plugin es dueno de la cabecera `Authorization` para
`api.commandcode.ai`, porque la key que inyecto el host puede ser justo la que
devolvio `402`. En modo key unica se mantiene la regla anterior: inyectar solo si
el request no trae cabecera.

### Estabilidad de sesion

Cuatro hooks independientes, todos fail-open (un error del plugin nunca puede romper
un request):

- **Higiene de conexion** - OpenCode corre sobre Bun, que habla HTTP/1.1 con
  keep-alive hacia Cloudflare. Cloudflare cierra sockets inactivos bajo carga y Bun
  expone la reutilizacion muerta como `ECONNRESET`. El hook aplica `Connection: close`
  in-place en cada request a Command Code (verificado: Bun reenvia la cabecera y
  Cloudflare responde `connection: close`). Es un arreglo a nivel de request, no una
  garantia total; ver [TROUBLESHOOTING](docs/es/troubleshooting.md#reintentos-por-econnreset).
- **Sanitizador de payload** - repara el historial de mensajes que dispara
  `HTTP 400 invalid request error`: respuestas de herramienta huerfanas o fuera de
  orden, llamadas desatendidas, `tool_call_id` duplicados o faltantes,
  `function.arguments` no-string, contenido de herramienta `null` o vacio.
- **Watchdog de inactividad SSE** - el primer chunk abre una ventana de 60s; si el
  stream queda mudo despues sin cerrarse, se aborta y se registra en lugar de congelar
  el turno. El tiempo previo al primer chunk queda a cargo del timeout propio de
  OpenCode, porque el modelo puede estar pensando legitimamente.
- **Registro de reintentos** - persiste los reintentos de transporte solo de Command
  Code, para poder diagnosticar una caida upstream a posteriori.

### Zero data retention (opt-in)

Command Code expone ZDR como cabecera de peticion (`x-cmd-zdr: 1`), el mismo
opt-in que su CLI lee de `CMD_ZDR=1`. El plugin lo replica:

- `CMD_ZDR=1` - toda peticion a `api.commandcode.ai` lleva `x-cmd-zdr: 1`.
- En cualquier otro caso - se elimina cualquier `x-cmd-zdr` enviada por el
  cliente, para que una sesion sin opt-in no pueda emitir la cabecera por error.

La cabecera solo se aplica en el host estricto de Command Code, nunca en un host
parecido que solo comparta `/provider/v1/...` en la ruta.

### Telemetria de cuota

- Herramienta `commandcode_quota` y comando `/commandcode-quota`: plan, estado,
  credito mensual restante, ventanas de rate limit de 5h y semanal con temporizador de
  reset, mas los totales del ciclo (peticiones, tokens, gasto).

### Errores accionables

Los fallos de Command Code conservan su status HTTP y su envelope JSON, pero el
mensaje gana una pista de resolucion:

| Fallo | Pista agregada |
| --- | --- |
| `402` creditos insuficientes | agrega creditos u otra cuenta a `COMMANDCODE_API_KEYS` |
| `MODEL_NOT_IN_PLAN` | elige otro modelo o sube de plan |
| `401` / `403` | reemplaza la key o rota el pool |
| `429` / ventana del plan | espera el reset o rota a otra key |
| `unsupported_model` | el modelo es Anthropic-shaped y solo se sirve en `/messages` |

Solo se tocan cuerpos JSON de error, el status nunca se reescribe (la clasificacion
de reintentos de OpenCode depende de el) y cada decoracion se registra en
`<state>/commandcode-errors.log`.

---

## Requisitos

- OpenCode v2.0+ (el export `server()` de v1 se mantiene como shim de compatibilidad).
- Runtime Bun (el plugin se carga desde fuente; sin build y sin `npm install`).
- Una API key de Command Code en cualquiera de los almacenes listados arriba.

---

## Instalacion

### Opcion A: Directo desde GitHub (recomendada)

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugins": ["github:JoshRob297/opencode-commandcode"]
}
```

OpenCode clona, cachea y ejecuta el plugin desde el repositorio. Sin publicacion en npm y
sin build: el codigo fuente es TypeScript ejecutado por Bun.

### Opcion B: Clon local

```bash
git clone git@github.com:JoshRob297/opencode-commandcode.git
```

```jsonc
{
  "plugins": [
    "/ruta/absoluta/a/opencode-commandcode"
  ]
}
```

### Opcion C: directorio de plugins

OpenCode tambien auto-descubre todo directorio dentro de `~/.config/opencode/plugins/`,
asi que un clon ahi se carga sin tocar `opencode.json`. La remocion no es simetrica:
borrar la entrada del config o renombrar el directorio **no** lo descarga; el directorio
tiene que salir de `plugins/` por completo. Ver
[TROUBLESHOOTING](docs/es/troubleshooting.md#plugin-cargado-dos-veces-o-un-plugin-eliminado-sigue-corriendo).

Reinicia OpenCode. En el siguiente arranque se descubre el catalogo de modelos, se
registran la herramienta y el comando de barra, y se enganchan los hooks.

> [!IMPORTANT]
> No ejecutes este plugin junto a un segundo plugin que registre
> `commandcode_quota`. Los ids de herramienta duplicados y los hooks `http.request`
> en competencia provocan doble sanitizado de requests. Elimina la entrada del plugin
> viejo durante el cutover.

### Configuracion del proveedor

El plugin no gestiona la definicion del proveedor. `opencode.json` sigue necesitando
el bloque del provider (la lista de modelos dentro es opcional; el descubrimiento los
agrega en runtime):

```jsonc
{
  "providers": {
    "commandcode": {
      "name": "Command Code",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "https://api.commandcode.ai/provider/v1",
        "apiKey": "{file:~/.config/commandcode/key.txt}"
      }
    }
  }
}
```

## Orden de modelos y modelos ajenos

El orden del selector lo maneja el plugin, no el catalogo:

1. **Primero los promo / free**, con el badge `Free` del runtime. El plugin escribe una
   entrada de `cost` con input en cero para esos modelos, lo que otorga el badge y ademas
   reporta su costo real como cero.
2. **Agrupados por familia** (Claude, GPT, Gemini, DeepSeek, Kimi, GLM, MiniMax, Qwen, ...).
3. **La version mas nueva primero dentro de cada familia** (`gpt-6.1-sol` antes que
   `gpt-6-sol` antes que `gpt-5.6-sol`), derivado de la version en el id del modelo.

Se materializa en el `time.released` de cada modelo, asi que sobrevive a los refrescos del
catalogo y los modelos nuevos se ubican solos sin editar el plugin.

`models.dev` publica ademas su propio provider `commandcode`, que OpenCode mergea con el
configurado. Ese merge trae los `claude-*` de forma Anthropic, que responden
`400 unsupported_model` en el transporte compatible con OpenAI, por eso el plugin desactiva
todo modelo del provider que no forme parte de su catalogo curado.

---

## Configuracion

Cada ajuste es una variable de entorno con default seguro. Referencia completa:
[docs/es/configuration.md](docs/es/configuration.md).

| Variable | Default | Proposito |
| --- | --- | --- |
| `COMMAND_CODE_API_KEY` | - | Resolucion de la key, maxima prioridad |
| `COMMANDCODE_KEY_FILE` | - | Ruta absoluta a un archivo con la key |
| `COMMANDCODE_API_KEYS` | - | Pool de keys; dos o mas activan rotacion |
| `COMMANDCODE_KEYS_FILE` | - | Archivo pool (`label=key` o key pelada por linea) |
| `CMD_ZDR` | - | `1` para zero data retention (`x-cmd-zdr: 1`) |
| `COMMANDCODE_ALLOWED_HOSTS` | - | Hosts extra separados por coma autorizados a recibir la key |
| `CC_NO_CONNECTION_CLOSE` | `0` | Poner en `1` para dejar de inyectar `Connection: close` |
| `COMMANDCODE_STATE_DIR` | `$XDG_STATE_HOME/opencode` | Donde viven los logs y la cache de modelos |
| `COMMANDCODE_LIVE_TESTS` | `0` | Poner en `1` para correr la suite de tests con red |
| `COMMANDCODE_OUTPUT_TOKENS` | `32768` | Limite de tokens de salida declarado por modelo (OpenCode lo envia como `max_completion_tokens`). Subilo si un modelo soporta mas |

Kill switch en runtime para la higiene de conexion: crea un archivo centinela llamado
`.disable-connection-close` dentro del directorio del plugin.

---

## Archivos de telemetria

| Archivo | Contenido |
| --- | --- |
| `<state>/commandcode-sanitizer.log` | Cada reparacion de payload en vuelo, con las correcciones aplicadas |
| `<state>/commandcode-watchdog.log` | Streams SSE abortados por inactividad |
| `<state>/commandcode-retries.log` | Reintentos de transporte de Command Code: sesion, agente, proveedor, modelo, tipo de error, status HTTP, numero de intento, delay del backoff y mensaje |
| `<state>/commandcode-rotation.log` | Cooldowns de keys: etiqueta, status HTTP, motivo y hora de reset |
| `<state>/commandcode-keys-state.json` | Estado de cooldown por etiqueta (solo etiquetas, 0600) |
| `<state>/commandcode-models-cache.json` | Ultimo catalogo de modelos bueno (TTL 6h) |

`<state>` por defecto es `~/.local/state/opencode`.

El log de reintentos es un artefacto forense, no una metrica de salud: OpenCode ya
reintenta fallos de transporte transitorios de forma nativa (10 intentos, backoff de
2s a 10s), asi que una rafaga de entradas `ECONNRESET` normalmente significa una
caida upstream que se recupero de forma transparente. Ver
[TROUBLESHOOTING](docs/es/troubleshooting.md).

---

## Desarrollo

```bash
bun install
bun test              # suite offline, sin red, sin consumir cuota
bun run test:live     # suite con red, consume una cantidad insignificante de cuota
bun run typecheck     # tsc estricto, sin emit
```

Estructura:

```
index.ts                 entrypoint del plugin (setup v2 + server v1)
src/auth/resolver.ts     resolucion multi-fuente de credenciales
src/client/api.ts        cliente HTTP, payloads de cuota, cache del catalogo
src/hooks/resilience.ts  helpers puros: guardas de URL, sanitizador, watchdog, clasificadores
src/tools/quota.ts       formateo del reporte de cuota
src/index.ts             registro de hooks, catalogo, herramienta y comando
tests/                   suites de bun test
```

Reglas de diseno que no se deben romper:

- Fail-open en todo: un error del plugin nunca debe fallar un request de modelo.
- Las credenciales solo se adjuntan con coincidencia exacta de host.
- La exactitud del catalogo vale mas que su tamano: no registres modelos que el
  transporte no puede servir.
- Sin rutas de usuario hardcodeadas.

Arquitectura y flujo de datos: [docs/es/architecture.md](docs/es/architecture.md).

---

## Licencia

MIT - ver [LICENSE](LICENSE).
