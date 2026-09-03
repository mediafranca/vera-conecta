# Brief de elicitación para Allium

Este documento prepara la conversación; no sustituye las especificaciones.
Allium debe describir **qué garantiza Vera Conecta**, mientras
`03-arquitectura.md` y `06-cloudflare.md` describen cómo pensamos implementarlo.

## Límite sugerido de specs

1. `installation-link.allium`: registro, emparejamiento, conexión, rotación y
   revocación de una instalación.
2. `client-grants.allium`: autorización, alcances, expiración y revocación por
   cliente.
3. `mcp-relay.allium`: aceptación, entrega, respuesta, desconexión, timeout e
   incertidumbre de solicitudes.
4. `privacy-and-audit.allium`: datos admitidos/prohibidos, retención y borrado.
5. `service-operations.allium`: degradación, límites, versiones y rollback.

OAuth, WebSocket, Cloudflare y almacenamiento son dependencias o implementación,
salvo donde su comportamiento sea visible para actores.

## Procesos y resultados

- Emparejar: una instalación obtiene una identidad durable sin exponer Vera.
- Conectar: exactamente un Desktop legítimo queda disponible para su ID.
- Autorizar: un cliente recibe sólo los alcances consentidos.
- Relayar: una solicitud autenticada llega a la Vera correcta una vez o termina
  con un resultado explícito.
- Revocar: el cliente deja de acceder sin afectar a otros.
- Recuperar: reinicios y despliegues no confunden instalaciones ni duplican
  escrituras.
- Eliminar: desaparece el estado del relay sin afectar el grafo local.

## Invariantes candidatas

- Un ID público jamás basta para autorizar.
- Una solicitud nunca cruza de una instalación a otra.
- Un alcance remoto nunca se amplía al convertirse en permiso local.
- El relay nunca persiste contenido MCP ni secretos Vera.
- Una revocación impide toda nueva solicitud de ese cliente.
- Una escritura ambigua nunca se reintenta automáticamente.
- Una respuesta exitosa corresponde a la misma solicitud, sesión e instalación.
- Una instalación eliminada no revela si existió a una persona no autorizada.
- La desconexión no convierte al relay en una copia servible de Vera.

## Superficies candidatas

- estado de conexión para la persona;
- consentimiento y lista de clientes autorizados;
- estado/errores del cliente MCP;
- eventos operativos para MediaFranca sin contenido;
- información de compatibilidad y versión para Desktop.

## Preguntas que deben resolverse durante la elicitación

1. ¿El primer piloto permite escritura o sólo lectura?
2. ¿Qué alcances de producto existen además de `read` y `write`?
3. ¿Quién inicia/revoca autorizaciones si Desktop está offline?
4. ¿Cuánto duran pairing code, access token, refresh token y periodo de borrado?
5. ¿Se permite más de una conexión Desktop simultánea por instalación?
6. ¿Qué significa recuperar una instalación después de reinstalar el sistema?
7. ¿Qué clientes forman el contrato v1 y cuáles son sólo experimentales?
8. ¿Qué respuesta debe recibir un cliente ante una escritura indeterminada?
9. ¿Qué metadatos operativos y retenciones acepta jurídicamente MediaFranca?
10. ¿El ID público puede regenerarse conservando autorizaciones o las revoca?
11. ¿Cómo se prueba consentimiento cuando el cliente no ofrece OAuth dinámico?
12. ¿Qué SLO puede sostener realmente el presupuesto del piloto?

## Escenario concreto para iniciar la sesión

“Ana abre Vera Desktop, conecta Claude, concede lectura y escritura, consulta una
página, crea un bloque y luego revoca Claude mientras mantiene ChatGPT. Durante
la escritura se cae su Wi-Fi.” Recorrer este caso obliga a resolver identidad,
consentimiento, idempotencia, desconexión y recuperación sin saltar a detalles
de Cloudflare.
