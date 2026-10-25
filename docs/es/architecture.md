# Arquitectura

[English](../ARCHITECTURE.md) | **Espanol**

## Mapa de modulos

```
index.ts                     entrypoint: `export default { id, setup, server }`
src/index.ts                 registro de hooks, catalogo de modelos, herramienta y comando
src/auth/resolver.ts         cascada de credenciales (I/O puro, sin red)
src/client/api.ts            cliente de la API de Command Code + cache del catalogo en disco
src/hooks/resilience.ts      helpers puros (sin efectos secundarios salvo la revision del centinela)
src/tools/quota.ts           formateo del payload de cuota
```

`src/hooks/resilience.ts` es deliberadamente libre de dependencias y de efectos
secundarios, para que cada regla que protege un request o una credencial se pueda
probar en aislamiento sin una instancia de OpenCode corriendo.

## Ciclo de vida

```
Arranque de OpenCode
      |
      v
plugin.setup(ctx)
      |
      +-- ctx.session.hook("http.request")   -> higiene de conexion
      |                                      -> inyeccion de credencial (solo host exacto)
      |                                      -> sanitizador de payload
      +-- ctx.session.hook("http.response")  -> watchdog de inactividad SSE
      +-- ctx.session.hook("retry")          -> telemetria de reintentos (solo Command Code)
      +-- ctx.model.transform()              -> registro del catalogo + etiquetas de promo
      +-- ctx.tool.transform()               -> commandcode_quota
      +-- ctx.command.transform()            -> /commandcode-quota
```

Los hooks y transforms se registran una sola vez. El transform del modelo lee el
catalogo que se resolvio antes del registro, asi que `setup` hace como maximo una
llamada de red y esta acotada por `AbortSignal.timeout(10s)` con fallback a disco.

## Ruta de un request

```
OpenCode -> request de modelo
      |
      v
[hook http.request]
      |
      |-- es de Command Code?
      |     no  -> retorna intacto (salida temprana)
      |     si  -> continua
      |
      |-- A. higiene de conexion
      |     setea `connection: close` in-place sobre el Request existente
      |     (preserva AbortSignal, cuerpo y cabeceras; nunca lo reconstruye)
      |
      |-- B. inyeccion de credencial
      |     solo si hostname === api.commandcode.ai (o esta en la allow-list)
      |     y todavia no hay cabecera `authorization`
      |
      |-- C. sanitizador de payload
      |     lee un clon del cuerpo, lo repara y reconstruye el Request
      |     SOLO cuando algo cambio realmente
      |
      v
Command Code
      |
      v
[hook http.response]
      |
      |-- es SSE y de Command Code? -> lo envuelve en el watchdog de inactividad
      |-- en otro caso              -> retorna intacto
      |
      v
Sesion de OpenCode
```

### Por que el sanitizador reconstruye solo si hace falta

Reconstruir un `Request` no descarta nada de forma explicita, pero sigue siendo un
objeto nuevo con un stream de cuerpo nuevo. Hacerlo en cada request seria un
desperdicio y perderia estado a nivel de cuerpo que OpenCode pueda haber adjuntado.
Por eso el sanitizador devuelve `modified: false` para input limpio y el `Request`
original viaja intacto. La ruta de reconstruccion preserva metodo, url, signal y
cabeceras, y elimina `content-length` a proposito para que el runtime lo recalcule
desde el nuevo cuerpo.

### Por que la guarda de credenciales parsea la URL

El plugin adjunta un secreto. Una verificacion por substring como
`url.includes("api.commandcode.ai")` la satisface
`https://api.commandcode.ai.attacker.com/` y tambien
`https://evil.com/?next=api.commandcode.ai`, mientras que una verificacion por path
como `url.includes("/provider/v1/chat/completions")` la satisface cualquier endpoint
propio o proxeado. Cualquiera de los dos errores convierte el plugin en una primitiva
de exfiltracion de credenciales. `isCommandCodeHost()` parsea la URL y compara el
hostname de forma exacta; `COMMANDCODE_ALLOWED_HOSTS` es la unica via de escape
sancionada.

El matcher amplio `isCommandCodeRequest()` sigue existiendo, porque reparar un payload
no lleva ningun secreto, pero nunca se usa en la ruta de inyeccion.

## Reglas del sanitizador

Se aplican en orden. Cualquier regla que se dispare marca `modified: true` y queda
registrada en `commandcode-sanitizer.log`.

| # | Regla | Disparador |
| --- | --- | --- |
| 1 | Eliminar entradas `tool_call` malformadas | la entrada es `null` o no es un objeto |
| 2 | Agregar `tool_call.id` faltante | llamada de asistente sin id |
| 3 | Deduplicar `tool_call.id` | dos llamadas comparten id |
| 4 | Convertir `function.arguments` a string | los argumentos no son string |
| 5 | Descartar respuestas de herramienta huerfanas o fuera de orden | mensaje `tool` cuyo `tool_call_id` no fue declarado por un mensaje de asistente **antes** de el |
| 6 | Normalizar contenido de herramienta `null` o vacio | el contenido es `null`, `undefined` o `""` -> `"{}"` |
| 7 | Inyectar respuesta de herramienta sintetica | `tool_calls` de asistente sin responder dentro de su bloque contiguo |

La regla 5 es sensible al orden a proposito. El fallo de campo que la origino es un
slice de historial que arranca en medio de un grupo de herramientas, dejando un
mensaje `tool` inicial sin llamada que lo declare; Command Code responde al request
completo con un `HTTP 400 invalid request error` generico. Mantener la verificacion
sensible al orden tambien cubre el caso hermano, donde un resultado de herramienta
llega antes que su llamada.

La entrada se clona de forma superficial: el payload del llamador nunca se muta.

## Semantica del watchdog

```
llega el chunk 1            se arma la ventana de inactividad de 60s
    |                             |
    |<-------- siguen llegando chunks -------->
                                  |
                          no llega chunk en 60s
                                  |
                                  +-> onTimeout() -> <state>/commandcode-watchdog.log
                                  +-> controller.error(...) -> el turno falla rapido
                                  +-> reader.cancel()
```

- La ventana se arma **despues** del primer chunk, para no penalizar un primer token
  lento.
- La cancelacion del consumidor limpia el temporizador, para que no dispare un abort
  espurio sobre un stream sano que el usuario interrumpio.
- Los errores del upstream se propagan sin cambios.
- El callback del temporizador y el abort estan envueltos: un error al loguear nunca
  puede dejar el stream abierto.

## Reglas del catalogo de modelos

```
catalogo vivo (red, timeout 10s)
        |
        +-- ok --------> filtrar -> registrar -> escribir cache (TTL 6h)
        |
        +-- falla -----> leer cache -> registrar
                              |
                              +-- vacio -> omitir el registro (gana la config curada)
```

Filtros y anotaciones del registro:

| Regla | Motivo |
| --- | --- |
| Omitir modelos sin `/chat/completions` | el proveedor es compatible con OpenAI; los de forma Anthropic responden `400 unsupported_model` |
| Etiquetar `[FREE PROMO]` cuando se detecta gratis/promo | los tiers gratuitos rotan seguido y son faciles de pasar por alto en el selector |
| Preservar `context_length` | evita sorpresas de truncado silencioso por modelo |
| Agregar entrada `image` cuando el modelo parece multimodal | los metadatos de capacidad alimentan la UI y la validacion de entrada |

Una cache vacia no es un error: cuando tanto la llamada de red como la cache estan
vacias, el plugin no registra nada y los modelos configurados de forma estatica siguen
funcionando.

## Modelo de fallos

| Situacion | Comportamiento |
| --- | --- |
| Command Code inalcanzable al arrancar | catalogo cacheado, o nada registrado |
| Falta la API key | sanitizador y watchdog siguen operativos; la inyeccion se omite |
| El sanitizador lanza una excepcion | el request original continua intacto |
| El logueo del watchdog lanza una excepcion | el stream se aborta igual, de forma limpia |
| El build no soporta el hook `retry` | el registro se captura y se ignora |
| El editor de modelos lanza por modelo | ese modelo se omite, los demas se registran |
| OpenCode v1 | `server()` expone unicamente la herramienta de cuota |
