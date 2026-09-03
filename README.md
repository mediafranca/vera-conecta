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

**M0 completo, M1 en curso.** Las cinco specs Allium (`specs/*.allium`) fijan el
contrato; cada una deja preguntas abiertas explícitas todavía sin decidir.

El canal de enlace de `installation-link.allium` es el primer walking skeleton
probado extremo a extremo, sin memoria real: emparejamiento de un solo uso,
apertura del canal WebSocket hibernable, latido, desplazamiento de conexión,
revocación por silencio o abandono, y un eco correlacionado por `request_id`
que demuestra transporte de solicitud/respuesta. Nada de esto todavía toca
MCP ni el grafo de Vera. `/health` responde; las rutas de producto que aún no
tienen contrato probado (MCP, OAuth, control de instalación) contestan `501`
deliberadamente.

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
