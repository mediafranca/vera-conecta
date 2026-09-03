# ADR 0001: Cloudflare Workers + Durable Objects

Estado: aceptada provisionalmente para el piloto.

Usaremos un Worker y un Durable Object SQLite por instalación, con WebSocket
Hibernation. Coincide con una conexión saliente persistente y ociosa, evita un
coordinador externo y deja DNS/TLS en la zona Cloudflare existente.

Cloud Run queda como alternativa si las pruebas revelan incompatibilidad,
límites de protocolo o costos inesperados. La decisión se revisa tras M2 con
mediciones reales, no por preferencia de proveedor.
