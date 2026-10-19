# Solucion de problemas

[English](../TROUBLESHOOTING.md) | **Espanol**

## No aparecen modelos de Command Code en el selector

1. Verifica que la cache del catalogo se haya escrito:

   ```bash
   ls -la "${COMMANDCODE_STATE_DIR:-$HOME/.local/state/opencode}/commandcode-models-cache.json"
   ```

2. Si el archivo no existe, el plugin nunca llego a la API. Comprueba que la key se
   resuelve y que el endpoint responde:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' \
     -H "Authorization: Bearer $(cat ~/.config/commandcode/key.txt)" \
     -H 'User-Agent: cli' \
     https://api.commandcode.ai/provider/v1/models
   ```

   Un `200` significa que el plugin deberia poblar la cache en el proximo arranque.

3. Los modelos que listaste a mano en `opencode.json` no se ven afectados: siguen
   registrados aunque el descubrimiento se omita. Una cache vacia no es un error.

4. Los modelos Claude estan ausentes a proposito. Solo exponen `/messages` y responden
   `400 unsupported_model` en el endpoint compatible con OpenAI. Ver mas abajo.

## `HTTP 400 unsupported_model` al seleccionar un modelo Claude

La familia `claude-*` en Command Code tiene forma Anthropic:

```json
{"error":{"message":"Model \"claude-sonnet-5\" must be called via /provider/v1/messages (Anthropic Messages shape).","type":"invalid_request_error","code":"unsupported_model"}}
```

El proveedor esta registrado como `@opencode/ai/providers/openai-compatible`, que habla
`/chat/completions`. El descubrimiento omite estos modelos por ese motivo. Si igual
ves el error, el modelo fue agregado a mano en `opencode.json`; quitalo de ahi o
enrutalo por un provider de forma Anthropic.

## `HTTP 400 invalid request error`

Este es el rechazo generico para el que existe el sanitizador. Revisa si fue un
problema de payload o algo distinto:

```bash
tail -20 "${COMMANDCODE_STATE_DIR:-$HOME/.local/state/opencode}/commandcode-sanitizer.log"
```

- **Hay entradas cerca del fallo** - el sanitizador reparo el payload y el request fue
  rechazado por otra razon. El array `fixes` lista exactamente que se reescribio; un
  rechazo posterior a una reparacion normalmente significa que el error upstream no
  tiene que ver con la estructura de las llamadas de herramienta.
- **No hay ninguna entrada** - el request estaba estructuralmente limpio para el
  sanitizador. Causas comunes: un modelo que ya no existe (ver la seccion de tiers
  retirados), un campo no soportado en el cuerpo, o un request que el plugin nunca vio
  porque otro plugin lo reconstruyo antes.

El sanitizador es fail-open: si lanza una excepcion, el request original se envia sin
cambios, asi que una linea faltante en el log tambien puede significar que la ruta de
reparacion fallo. No hace falta habilitar nada extra para eso; el diseno se traga los
errores de hook a proposito.

## `HTTP 403 permission_error` en un modelo gratuito

Los tiers gratuitos se retiran sin aviso y el id sigue resolviendo:

```json
{"error":{"message":"The free Ling 3.1 Flash tier has been retired. Ling 3.1 Flash is now a paid model ...","type":"permission_error","code":"FORBIDDEN"}}
```

Despues, la API expone el id de pago (por ejemplo `inclusionai/ling-3.1-flash`), y el
descubrimiento lo toma en el proximo arranque. Corrige una entrada obsoleta en
`opencode.json` alineandola con `/provider/v1/models`:

```bash
curl -s -H "Authorization: Bearer $(cat ~/.config/commandcode/key.txt)" \
     -H 'User-Agent: cli' https://api.commandcode.ai/provider/v1/models \
  | grep -o '"id": *"[^"]*"' | sort
```

Si un modelo listado ahi igual falla, la promo termino entre tu request y el refresco
del catalogo. Reselecciona y continua.

## Reintentos por `ECONNRESET`

El log de reintentos es una huella forense, no un contador de fallos:

```bash
grep -c . "${COMMANDCODE_STATE_DIR:-$HOME/.local/state/opencode}/commandcode-retries.log"
grep -o '"type":"[^"]*"' "${COMMANDCODE_STATE_DIR:-$HOME/.local/state/opencode}/commandcode-retries.log" \
  | sort | uniq -c | sort -rn
```

Que significa cada entrada:

| `type` | Significado |
| --- | --- |
| `provider.transport` (ECONNRESET) | socket obsoleto o cortado; se reintenta de forma nativa |
| `provider.internal` (503) | sobrecarga upstream; se reintenta de forma nativa |
| `provider.invalid-output` | el stream termino sin `finish_reason` |
| `provider.invalid-request` | HTTP 400 del proveedor |

OpenCode reintenta los fallos de transporte transitorios por su cuenta (10 intentos,
backoff de 2s a 10s), asi que una rafaga recuperada nunca llega al usuario. La
inyeccion de `Connection: close` elimina una causa concreta (Bun reutilizando un socket
que Cloudflare ya cerro); no elimina los resets originados del lado upstream durante una
caida. Medido en un host de produccion: 99 de 130 eventos fueron resets `transport`
repartidos en diez dias, concentrados en rafagas cortas upstream, con cero sesiones sin
recuperar.

Para medir el efecto de la inyeccion, deshabilitala y compara:

```bash
export CC_NO_CONNECTION_CLOSE=1   # se restaura la reutilizacion de keep-alive
```

## Un turno se cuelga con una herramienta en `streaming`

El watchdog aborta un stream SSE mudo despues de 60s:

```bash
cat "${COMMANDCODE_STATE_DIR:-$HOME/.local/state/opencode}/commandcode-watchdog.log"
```

- **Existe una entrada `watchdog.timeout`** - el abort se disparo como esta disenado y
  el turno fallo rapido en lugar de congelarse.
- **No hay entrada ni archivo** - el cuelgue ocurrio antes del primer chunk, ventana que
  el watchdog no vigila a proposito. Esa ventana pertenece al timeout del proveedor en
  OpenCode. Verifica que el request llego a la red, luego sube ese timeout o reintenta.

## No se encuentra la key

La herramienta de cuota responde
`Error consultando Command Code: No se encontro ...`. Revisa que almacen ve el
resolvedor:

```bash
bun -e 'import { resolveApiKeyWithSource } from "./src/auth/resolver.ts";
console.log(resolveApiKeyWithSource().source);'
```

`none` significa que los seis almacenes quedaron vacios. La solucion mas simple es la
variable de entorno:

```bash
export COMMAND_CODE_API_KEY="tu-key"
```

Nota que el plugin sigue funcionando sin key: sanitizador, watchdog y cache del
catalogo siguen operativos, solo se omite la inyeccion de credencial.

## La cuota sale vacia o parcial

Cada campo se obtiene de forma independiente y un fallo degrada a `N/D` en lugar de
matar el reporte. Un reporte que muestra plan y ventanas pero sin totales de ciclo
significa que solo fallo `/alpha/usage/summary`. Reintenta; si la cuenta se creo hace
poco, el endpoint de resumen puede estar vacio los primeros minutos.

## Registro duplicado de herramientas

Sintoma: OpenCode loguea un id de plugin duplicado o `commandcode_quota` aparece dos
veces. Causa: un segundo plugin que registra la misma herramienta o los mismos hooks
(por ejemplo el plugin legacy `commandcode-quota`) sigue listado en `opencode.json`.
Quita la entrada vieja; correr ambos significa que los requests se sanitizan dos veces
y la segunda pasada ve un payload ya reparado.

## Los logs no se escriben

El plugin es fail-open, asi que los fallos de telemetria son silenciosos. Verifica que
el directorio de estado sea escribible:

```bash
mkdir -p "${COMMANDCODE_STATE_DIR:-$HOME/.local/state/opencode}" && touch "$_/probe" && rm "$_/probe"
```

Un log de sanitizador vacio es el estado normal: solo recibe una entrada cuando un
payload realmente necesito reparacion.

## Plugin cargado dos veces, o un plugin eliminado sigue corriendo

OpenCode carga plugins desde dos lugares: el array `plugins` de `opencode.json` **y**
todo directorio dentro de `~/.config/opencode/plugins/` (auto-descubrimiento). Esa
asimetria explica los dos casos confusos:

| Sintoma | Causa |
| --- | --- |
| Un plugin que quitaste de `plugins` sigue apareciendo en `opencode plugin list` | Vive en `~/.config/opencode/plugins/` y lo toma el scan de directorio |
| Un plugin renombrado a `.disabled` dentro de ese directorio igual se carga | El scan toma cualquier subdirectorio, no solo archivos `.ts` ni el nombre original |

Que funciona y que no:

```bash
# NO lo descarga
# - quitar la entrada de opencode.json
# - renombrar el directorio dentro de plugins/
# - reescribir opencode.json para forzar un reload

# SI lo descarga (el watcher lo suelta en vivo)
mv ~/.config/opencode/plugins/tu-plugin ~/fuera-del-directorio/tu-plugin
```

Verifica con:

```bash
opencode plugin list
```

Si el plugin sigue listado despues de moverlo, el servicio en ejecucion lo mantuvo en
memoria: reinicia el servidor en background (`opencode service stop`) y volve a abrir
OpenCode. Nota que `opencode service restart` por si solo tambien sirve, pero corta la
conexion del TUI actual.

Dos plugins registrando `commandcode_quota` no es fatal - el sanitizador es idempotente,
asi que la segunda pasada devuelve `modified: false`, y el tool se expone una sola vez -
pero duplica el trabajo de los hooks y enturbia la telemetria, asi que mantene una sola
copia instalada.
