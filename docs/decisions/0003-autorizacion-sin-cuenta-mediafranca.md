# ADR 0003 — OAuth sin cuenta MediaFranca

## Estado

Aceptada para implementación incremental.

## Decisión

Vera Conecta es un relay MCP neutral. No compra inferencia, no recibe claves de
OpenAI o Anthropic y no suplanta la suscripción que la persona ya paga en
ChatGPT o Claude.

MediaFranca opera una sola puerta pública. Cada Vera Desktop mantiene una
conexión saliente hacia ella y conserva la autoridad de aprobar o revocar cada
cliente remoto.

La autorización tendrá dos ceremonias sobre una misma concesión:

1. **Bearer manual del piloto.** Desktop crea una identidad, muestra una sola
   vez la URL y el bearer, y permite revocarlo. Como los formularios de cabecera
   fija no conocen el refresco privado de Conecta, este bearer dura 90 días.
2. **OAuth 2.1.** El cliente descubre la autorización desde la URL MCP. El
   navegador muestra qué cliente y alcances solicita, pero la aprobación final
   ocurre en Vera Desktop. Los tokens de acceso son breves y renovables.

OAuth se implementará con `@cloudflare/workers-oauth-provider`, no con un
servidor casero. El relay publicará metadatos de recurso protegido, PKCE,
registro de clientes compatible y tokens ligados a la URL de la instalación.

## Consecuencias

- La persona no necesita dominio, cuenta Cloudflare ni una cuenta MediaFranca.
- Conocer `https://conecta.mediafranca.net/v/<id>/mcp` sólo ubica una Vera; no
  lista clientes ni concede acceso.
- La identidad de ChatGPT, Claude u otro cliente nunca se transforma en una
  credencial Vera más amplia que los alcances aprobados.
- El relay conserva hashes y estado de control, pero no claves de proveedores,
  prompts, páginas, bloques, adjuntos ni resultados MCP.
- Claude puede probar el recorrido completo antes de OAuth mediante una
  cabecera Bearer. ChatGPT entra en la beta cuando el flujo OAuth pase su prueba
  extremo a extremo contra un despliegue público.

## Alternativas descartadas

- **Una cuenta MediaFranca obligatoria:** añade identidad central y recuperación
  de cuenta donde el producto no la necesita.
- **Guardar API keys de modelos:** convierte el relay en broker de inferencia,
  mezcla pagos con acceso al corpus y amplía innecesariamente el daño posible.
- **OAuth escrito desde cero:** duplica PKCE, descubrimiento, registro,
  audiencia, rotación y revocación que una biblioteca mantenida ya implementa.
- **Un túnel por proveedor:** puede servir a un cliente concreto, pero pierde la
  puerta común y revocable para varias IAs.
