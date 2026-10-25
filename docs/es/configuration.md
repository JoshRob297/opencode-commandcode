# Configuracion

[English](../CONFIGURATION.md) | **Espanol**

Todos los ajustes son variables de entorno. Los defaults son seguros: sin ninguna
configuracion, el plugin resuelve la key desde los almacenes estandar y habilita
todos los hooks.

## Credenciales

| Variable | Default | Significado |
| --- | --- | --- |
| `COMMAND_CODE_API_KEY` | sin definir | Maxima prioridad. Se usa tal cual (recortada y sin comillas envolventes). |
| `COMMANDCODE_KEY_FILE` | sin definir | Ruta absoluta a un archivo que contenga solo la key. Se ignora si el archivo falta o esta vacio, para que la cascada continue. |
| `XDG_CONFIG_HOME` | `~/.config` | Base del tercer paso de resolucion: `$XDG_CONFIG_HOME/commandcode/key.txt`. |

### Orden de resolucion

```
COMMAND_CODE_API_KEY
      -> COMMANDCODE_KEY_FILE
      -> $XDG_CONFIG_HOME/commandcode/key.txt
      -> /etc/environment (COMMAND_CODE_API_KEY)
      -> ~/.commandcode/auth.json          (apiKey | api_key | token | accessToken)
      -> ~/.commandcode/credentials.json
      -> ~/.commandcode/config.json
      -> none  (inyeccion deshabilitada, el resto sigue funcionando)
```

`resolveApiKeyWithSource()` informa que almacen se uso, que es lo que verifican los
tests. `resolveApiKey()` devuelve solo el string.

### Allow-list de hosts

| Variable | Default | Significado |
| --- | --- | --- |
| `COMMANDCODE_ALLOWED_HOSTS` | sin definir | Hostnames separados por coma que tambien pueden recibir la key, ademas de `api.commandcode.ai`. |

Usala solo para un gateway propio que realmente termine tu trafico hacia Command Code.
Cada host que agregues aqui puede leer la API key.

```
COMMANDCODE_ALLOWED_HOSTS=gateway.internal,proxy.lan
```

## Transporte

| Variable | Default | Significado |
| --- | --- | --- |
| `CC_NO_CONNECTION_CLOSE` | sin definir | Poner en `1` para dejar de inyectar `Connection: close`. |
| archivo centinela `<plugin>/.disable-connection-close` | ausente | Mismo efecto que la variable, activable sin reiniciar. |

Ambos interruptores existen para poder deshabilitar la cabecera y medir, sin editar
codigo. Deshabilitarla restaura la reutilizacion de keep-alive, lo que reintroduce el
caso de `ECONNRESET` por socket obsoleto si es lo que estas sufriendo.

El timeout del watchdog (60s despues del primer chunk) es una constante en
`src/index.ts` (`WATCHDOG_TIMEOUT_MS`), no una variable de entorno.

## Telemetria y cache

| Variable | Default | Significado |
| --- | --- | --- |
| `COMMANDCODE_STATE_DIR` | `$XDG_STATE_HOME/opencode` o `~/.local/state/opencode` | Directorio de los tres logs y la cache de modelos. |

Archivos escritos bajo el directorio de estado:

| Archivo | Modo | Notas |
| --- | --- | --- |
| `commandcode-sanitizer.log` | append | JSON lines, una por payload reparado |
| `commandcode-watchdog.log` | append | JSON lines, una por stream abortado |
| `commandcode-retries.log` | append | JSON lines, solo reintentos de Command Code |
| `commandcode-models-cache.json` | sobrescritura | `{ at, models[] }`, TTL 6h |

Los logs son append-only y el plugin no los rota. A la tasa observada (decenas de
lineas por semana) no es un problema; si querés rotacion, apunta
`COMMANDCODE_STATE_DIR` a un directorio gestionado por `logrotate`.

## Constantes de tiempo

| Constante | Valor | Ubicacion |
| --- | --- | --- |
| Timeout de request a la API | 10s | `DEFAULT_TIMEOUT_MS` en `src/client/api.ts` |
| TTL de la cache del catalogo | 6h | `CATALOG_TTL_MS` en `src/client/api.ts` |
| Ventana de inactividad SSE | 60s | `WATCHDOG_TIMEOUT_MS` en `src/index.ts` |
| Limite de salida por defecto | 16384 | `applyModelCatalog` en `src/index.ts` |

## Integracion con OpenCode

El plugin se registra solo; en `opencode.json` unicamente va el bloque del provider.
Se instala con el especificador de GitHub (sin npm, sin build), con un clon local, o
dejandolo en el directorio de plugins auto-descubierto (ver el readme para las tres opciones).

```jsonc
{
  "plugins": [
    "github:JoshRob297/opencode-commandcode"
  ],
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

Notas:

- El mapa `models` dentro del provider es opcional. Lo que listes ahi gana para el
  mismo id; el descubrimiento agrega el resto al arrancar.
- Mantene `apiKey` en el bloque del provider como fallback para herramientas que
  eviten el plugin. El plugin resuelve la key de forma independiente.
- No cargues dos plugins que registren `commandcode_quota` al mismo tiempo.

## Interruptores de test

| Variable | Default | Significado |
| --- | --- | --- |
| `COMMANDCODE_LIVE_TESTS` | sin definir | Poner en `1` para correr `tests/live.test.ts`, que llama a la API real. |

```bash
bun test                             # offline, no consume cuota
COMMANDCODE_LIVE_TESTS=1 bun test    # agrega la suite con red
```
