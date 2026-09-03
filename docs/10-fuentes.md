# Fuentes técnicas

Estas fuentes son normativas o documentación primaria. Las decisiones de
producto están en los documentos del repositorio; un enlace no delega la
decisión en el proveedor.

- [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports): POST por mensaje, negociación JSON/SSE y validación de `Origin`.
- [Autorización MCP](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization): perfil OAuth aplicable al servidor remoto.
- [Remote MCP en Cloudflare](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/): construcción y prueba de servidores MCP remotos.
- [Seguridad MCP en Cloudflare](https://developers.cloudflare.com/agents/model-context-protocol/guides/securing-mcp-server/): OAuth Provider y consentimiento.
- [Configuración de Wrangler](https://developers.cloudflare.com/workers/wrangler/configuration/): bindings, environments, custom domains y exports de Durable Objects.
- [WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/): conexión persistente sin mantener el objeto activo.
- [Ciclo de vida de Durable Objects](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/): hibernación, reinicios y conexiones.
- [Límites de Workers](https://developers.cloudflare.com/workers/platform/limits/): memoria, requests, CPU y cuerpos.
- [Precios de Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/): modelo de costo que deberá verificarse con mediciones.
- [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/): DNS y TLS administrados en una zona Cloudflare existente.
