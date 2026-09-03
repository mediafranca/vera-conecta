# Arquitectura

## Componentes

### Worker de borde

Termina HTTPS, valida rutas, `Origin`, autenticación, tamaños y cuotas. Resuelve
el ID público al Durable Object determinista de la instalación. Sirve además
descubrimiento OAuth, salud y una consola mínima futura.

Este componente es un **Cloudflare Worker**. No es un *Service Worker* instalado
en el navegador: la terminología se parece porque comparten APIs web, pero Vera
Conecta corre en la infraestructura de Cloudflare.

### Durable Object `InstallationRelay`

Existe uno por instalación. Mantiene la conexión WebSocket hibernable de Vera
Desktop, correlaciona solicitudes en vuelo y conserva sólo metadatos mínimos:
estado de enlace, hashes de credenciales, revocaciones, contadores y versión de
protocolo. Usa almacenamiento SQLite del Durable Object.

### Conector de Vera Desktop

Se incorpora al producto Vera, no a este Worker. Mantiene reconexión con
backoff, almacena secretos en Keychain/Credential Manager/libsecret, convierte
sobres del relay en llamadas MCP a `127.0.0.1` y aplica la identidad Vera local.
Nunca escucha una interfaz pública.

## Rutas previstas

- `GET /health`: salud del despliegue, sin estado de usuarios.
- `POST /pairings`: inicia emparejamiento; protegido contra abuso.
- `POST /pairings/:code/claim`: reclama una sola vez.
- `GET /v/:installation/link`: upgrade WebSocket autenticado de Desktop.
- `POST|GET|DELETE /v/:installation/mcp`: Streamable HTTP MCP.
- `/.well-known/oauth-authorization-server`: metadatos OAuth.
- `/.well-known/oauth-protected-resource`: metadatos del recurso MCP.
- `/authorize`, `/token`, `/register`: OAuth cuando se habilite.
- `POST /v/:installation/clients/:client/revoke`: control autenticado; la
  interfaz final podrá delegarlo al canal Desktop en vez de exponerlo.

## Elección de Durable Objects

El patrón dominante es una conexión persistente, casi siempre ociosa, por
instalación. WebSocket Hibernation permite sacar el objeto de memoria sin cortar
el socket. Un único objeto serializa el estado de enlace y evita coordinadores
externos. Cloud Run era viable, pero cobraría/retendría instancias por conexiones
abiertas y exigiría coordinación entre réplicas.

## Datos persistidos

Permitidos: versión, timestamps, estado, hashes con pepper de tokens, alcances,
contadores, revocaciones, IDs aleatorios y últimos códigos de error clasificados.

Prohibidos: nombres de páginas, bloques, prompts, argumentos/resultados de
herramientas, cabeceras `Authorization` originales, adjuntos, transcripciones,
secretos Vera locales y contenido de respuestas.

## Separación de ambientes

- Local: Miniflare mediante `wrangler dev`, datos descartables.
- Staging: `vera-conecta-staging.<subdomain>.workers.dev`; identidades y secretos
  distintos, sin memorias reales.
- Producción: `conecta.mediafranca.net`.

Nunca se reutilizan namespace, tokens, secretos ni datos entre ambientes. El
binding de Durable Objects se declara por ambiente porque Wrangler no lo hereda.

## Escalamiento

El ID público determina un Durable Object; por ello no hay sticky sessions
manuales. El Worker transmite cuerpos en streaming y fragmenta el WebSocket para
no retener payloads grandes en los 128 MB de memoria. Un objeto sirve una
instalación, no una organización completa.
