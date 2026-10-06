# Contratos de transporte

## MCP público

El endpoint implementa MCP Streamable HTTP vigente. Cada mensaje JSON-RPC llega
por un POST nuevo. El cliente debe aceptar `application/json` y
`text/event-stream`. GET y DELETE se implementan sólo según las reglas de sesión
del transporte, no como API REST inventada.

El servidor valida `Origin` en toda conexión. Se aceptará una lista explícita de
clientes conocidos, ausencia de `Origin` para clientes nativos conformes y los
orígenes autorizados durante OAuth. Nunca se refleja cualquier origen ni se usa
`*` con credenciales.

## WebSocket de enlace

La conexión Desktop presenta:

- versión de protocolo;
- ID público de instalación;
- nonce y prueba ligada al secreto de enlace;
- versión de Vera y capacidades MCP;
- identificador efímero de conexión.

El relay responde con versión negociada, heartbeat y límites. El Durable Object
usa la API hibernable (`acceptWebSocket`), no listeners WebSocket ordinarios.

## Capturas de Vera Clip

`POST /v/:installation/captures` transporta una captura confirmada hacia la
puerta canónica de captura de Vera. No es MCP y no acepta operaciones genéricas
del grafo. La credencial sólo autoriza el alcance `capture`; Vera vuelve a
validar tamaño, forma, procedencia e idempotencia antes de escribir.

El relay no conserva una captura cuando Vera está desconectada. Devuelve
`503 vera_offline` y Vera Clip mantiene localmente la copia pendiente para un
reintento posterior. Después de entregar el sobre, una caída anterior al acuse
produce un resultado incierto: el cliente puede reintentar con la misma clave
de idempotencia, nunca fabricar una segunda captura con otra identidad.

## Sobre interno

Cada solicitud lleva sólo:

```text
request_id, session_id?, method, path, safe_headers,
principal_id, scopes, deadline, chunk_sequence, bytes
```

`request_id` es aleatorio y único. Los fragmentos tienen máximo inicial de 64
KiB. El producto limita una solicitud a 10 MiB en el piloto aunque Cloudflare
admita más. Nunca se incluye el bearer público después de validarlo.

## Semántica de entrega

- Lecturas pueden reintentarse si Desktop no acusó recepción.
- Escrituras no se reintentan después de una entrega ambigua.
- Vera conserva la idempotencia canónica mediante `originId`.
- Si el socket cae después de aceptar una escritura y antes de responder, el
  relay devuelve `result_indeterminate`; jamás afirma éxito ni vuelve a enviar
  ciegamente.
- Máximo inicial: 32 solicitudes concurrentes por instalación, 8 por cliente.
- Plazo inicial: 120 s, ampliable sólo por streaming/actividad explícita.

## Errores públicos

- `401`: falta o falla autenticación.
- `403`: credencial válida sin alcance, origen o instalación permitida.
- `404`: ID inexistente y revocado son indistinguibles.
- `409`: enlace desplazado o sesión incompatible.
- `413`: solicitud excede límite del producto.
- `429`: cuota; incluye `Retry-After`.
- `503 vera_offline`: instalación conocida pero no conectada.
- `504`: plazo agotado sin resultado concluyente.

Los cuerpos no revelan si existe una página, persona o instalación más allá de
lo que ya puede saber una credencial autorizada.

## Compatibilidad

Primero se prueba con MCP Inspector y Hermes. ChatGPT, Claude y otros clientes se
añaden sólo cuando su producto concreto admita servidores MCP remotos y después
de documentar su ceremonia real. El nombre de un modelo no implica soporte MCP.
