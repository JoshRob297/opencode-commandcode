# Politica de Seguridad

[English](SECURITY.md) | **Espanol**

## Alcance

Este plugin es una integracion del lado del cliente para el proveedor Command Code.
La propiedad mas sensible al seguridad del codigo es que **maneja una API key**, por
lo que los defectos en el manejo de credenciales se tratan como vulnerabilidades,
no como bugs.

Dentro de alcance:

- Fuga de credenciales o inyeccion de credenciales dirigida al host equivocado.
- Manipulacion de requests que altere un payload mas alla de las reparaciones
  documentadas.
- Cualquier ruta que permita a un tercero influir en que host recibe la API key.
- Telemetria que escriba secretos en disco o dentro de un archivo de log.

Fuera de alcance:

- Vulnerabilidades en OpenCode mismo (reportalas aguas arriba).
- Vulnerabilidades en la API o el servicio de Command Code (reportalas a Command Code).
- Calidad de la salida de los modelos, precios, politica de cuota o cambios de catalogo.
- Todo lo que requiera un host ya comprometido, acceso de shell como el usuario, o la
  capacidad de editar los propios archivos del plugin.

## Como reportar una vulnerabilidad

Usa el reporte privado de vulnerabilidades de GitHub en este repositorio
(pestana `Security` -> `Report a vulnerability`). No abras un issue publico.

Incluye, cuando sea posible:

- Version afectada o sha del commit.
- Una reproduccion minima: la URL del Request, la forma del payload, y que hizo el
  plugin frente a que deberia haber hecho.
- Si esta afectada una credencial, un payload o un stream.

Acuse de recibo en 72 horas, y un fix o un plan de mitigacion dentro de 14 dias para
los problemas confirmados. Credito en el changelog si lo pedis.

## Notas del modelo de amenazas

El plugin asume:

- El host y la cuenta de usuario son confiables. Quien pueda leer la API key en disco
  ya la tiene; el plugin no intenta proteger contra eso.
- `opencode.json` y la ruta del plugin son configuracion confiable.
- La API key es una credencial bearer con todos los privilegios de la cuenta. Acotala
  o rotala si sospechas que se expuso.

Reglas de diseno que existen por este modelo de amenazas:

| Regla | Motivo |
| --- | --- |
| Las credenciales se adjuntan solo tras una coincidencia exacta de hostname | la coincidencia por substring es trivialmente explotable (`api.commandcode.ai.evil.com`, coincidencias por path, query strings) |
| `COMMANDCODE_ALLOWED_HOSTS` es la unica allow-list | un opt-in explicito y auditable en lugar de una coincidencia difusa |
| En modo key unica nunca se sobrescribe una cabecera `authorization` existente | una credencial del cliente no debe reemplazarse en silencio |
| En modo rotacion el plugin es dueno de `authorization` en el host estricto de Command Code | la key que inyecto el host puede ser la que acaba de devolver 402; el pool es un opt-in explicito |
| `x-cmd-zdr` se elimina salvo que `CMD_ZDR=1` | una politica de retencion de datos no debe activarse por accidente |
| Los logs nunca registran la key, la cabecera `authorization` ni los cuerpos de request | los archivos `commandcode-*.log` son texto plano en disco |
| El sanitizador nunca reescribe campos distintos de `messages` | limita el radio de impacto de una modificacion de payload en vuelo |
| Todos los hooks son fail-open | un atacante no debe poder desactivar los requests de modelo induciendo un error del plugin |

## Checklist de endurecimiento para despliegues

- Mantene el archivo de la key en modo `600` y fuera de cualquier directorio
  sincronizado o respaldado.
- No habilites `COMMANDCODE_ALLOWED_HOSTS` salvo que un gateway propio realmente
  termine tu trafico hacia Command Code.
- Trata el directorio de estado como sensible: contiene metadatos de requests (ids de
  sesion, ids de modelo, mensajes de error) aunque nunca contiene la key.
- Revisa el diff antes de actualizar el plugin: corre con acceso completo a cada request
  de modelo de la sesion de OpenCode.
