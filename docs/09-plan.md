# Plan de implementación

## M0 — especificación

- resolver las preguntas del brief;
- escribir y validar las cinco specs Allium;
- convertir invariantes en obligaciones de prueba;
- definir compatibilidad MCP objetivo.

Salida: specs sin errores y decisiones abiertas explícitas.

## M1 — walking skeleton sin datos reales

- Worker, Durable Object SQLite y WebSocket hibernable;
- conector de prueba, no integrado en Vera;
- `/health`, enlace, request/response correlacionados;
- staging en `workers.dev`;
- pruebas de dos instalaciones para impedir cruces.

Salida: un eco autenticado extremo a extremo, no MCP productivo.

## M2 — MCP sólo lectura

- Streamable HTTP;
- bearer piloto, scopes y revocación;
- conector Desktop contra MCP local — primer recorrido real de catálogo y
  `vera_buscar` probado localmente; falta integrarlo al ciclo de vida de la app;
- errores offline, timeout, límites y streaming;
- MCP Inspector + Hermes.

Salida: lectura real con identidad Vera separada y sin contenido en logs.

## M3 — escritura gobernada

- mapeo remoto→credencial local;
- `originId`, resultado incierto y no-reintento;
- diff/revisión según políticas de Vera;
- pruebas de corte de red en cada frontera.

Salida: escritura atribuida, revocable e idempotente.

## M4 — OAuth y beta externa

- OAuth 2.1, consentimiento, expiración y refresh;
- interfaz “Conectar una IA”;
- Workers Paid, dominio y observabilidad filtrada;
- auditoría de seguridad, privacidad y aislamiento;
- runbooks y rollback.

Salida: beta limitada con participantes reales.

## Definition of done por cambio

- comportamiento cubierto por Allium y tests;
- no amplía datos persistidos sin decisión de privacidad;
- prueba multi-instalación;
- prueba de revocación y desconexión;
- typecheck, tests y dry-run de Wrangler;
- documentación y amenaza actualizadas;
- despliegue reversible.
