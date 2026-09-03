# Vera Conecta

Vera Conecta será el puente opcional entre una instalación local de
[Vera](https://github.com/mediafranca/vera) y los clientes MCP que viven en
Internet. La instalación inicia una conexión saliente; la persona no abre
puertos, no administra una IP pública y no instala Tailscale.

```text
ChatGPT / Claude / otro cliente MCP
              |
              | HTTPS + OAuth o bearer revocable
              v
https://conecta.mediafranca.net/v/<id-publico>/mcp
              |
              | Cloudflare Worker + Durable Object
              v
      WebSocket saliente persistente
              |
              v
       Vera Desktop -> MCP local
```

## Estado

**M0 completo, M1 casi completo.** Las cinco specs Allium (`specs/*.allium`) fijan
el contrato; cada una deja preguntas abiertas explícitas todavía sin decidir.

Probado extremo a extremo, sin memoria real:

- `installation-link.allium`: emparejamiento de un solo uso, apertura del canal
  WebSocket hibernable, latido, desplazamiento de conexión, revocación por
  silencio o abandono, rotación de secreto y revocación de la instalación. Falta
  sólo `DesktopRegeneraIdPublico`, aplazada porque exige migrar estado entre
  Durable Objects y la propia spec no resuelve si conserva las autorizaciones de
  cliente.
- `client-grants.allium`: autorizar un cliente MCP por instalación, que reclame
  su credencial propia, y revocarlo — individualmente o en cascada al revocar la
  instalación completa.
- `mcp-relay.allium`: `POST /v/:id/mcp` acepta, clasifica, entrega por el enlace
  activo y resuelve una solicitud MCP (respuesta, plazo agotado, Vera
  desconectada, reintento de lectura no acusada o conflicto de enlace tras un
  desplazamiento). Sesión MCP vía `Mcp-Session-Id`, abierta implícitamente por
  el primer POST y cerrada por `DELETE` o por el fin del acceso del cliente.
  Dos simplificaciones deliberadas: el transporte es petición/respuesta en un
  solo tramo, no streaming HTTP real; y la clasificación método MCP →
  clase/alcance es una decisión de implementación (lectura para
  descubrimiento/protocolo, escritura por defecto para el resto, empezando por
  `tools/call`), no algo que la spec resuelva.

`service-operations.allium` y `privacy-and-audit.allium` siguen sin
implementar, salvo el interruptor manual `escrituras_admitidas`
(`POST /v/:id/servicio`) que `mcp-relay` necesita — la degradación automática
por umbral sigue siendo la pregunta abierta de esa spec. `/health` responde;
OAuth (`client-grants` usa bearer del piloto) sigue fuera de alcance hasta M4.

No hay ningún ambiente desplegado: sólo se ha probado con `wrangler dev` y con
la suite sobre `@cloudflare/vitest-pool-workers`.

## Dirección acordada

- Producto: **Vera Conecta**.
- Repositorio: `vera-conecta`.
- Producción: `https://conecta.mediafranca.net`.
- MCP por instalación: `https://conecta.mediafranca.net/v/<id-publico>/mcp`.
- Hospedaje: Cloudflare Workers + Durable Objects con WebSockets hibernables.
- Zona DNS: la cuenta y zona existentes de `mediafranca.net` en Cloudflare.
- Plan: Free durante desarrollo; Workers Paid antes de una prueba externa.
- Memoria: el relay nunca conserva páginas, bloques, adjuntos ni respuestas MCP.

## Lectura recomendada

1. [Alcance y producto](docs/01-producto.md)
2. [Modelo de dominio y recorridos](docs/02-dominio-y-recorridos.md)
3. [Arquitectura](docs/03-arquitectura.md)
4. [Contratos de transporte](docs/04-protocolo.md)
5. [Seguridad y privacidad](docs/05-seguridad-y-privacidad.md)
6. [Cloudflare y despliegue](docs/06-cloudflare.md)
7. [Operación](docs/07-operacion.md)
8. [Brief para Allium](docs/08-allium-brief.md)
9. [Plan de implementación](docs/09-plan.md)
10. [Fuentes técnicas](docs/10-fuentes.md)

## Desarrollo

```sh
npm install
npm run typecheck
npm test
npm run dev
```

No ejecutar `npm run deploy:production` ni asociar el dominio sin revisión de
seguridad y autorización explícita. Los secretos se cargan con `wrangler secret
put`; jamás se escriben en Git, ejemplos, issues o logs.
