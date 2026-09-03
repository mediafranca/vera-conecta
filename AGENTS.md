# Instrucciones del repositorio

- Tratar `docs/01-producto.md` y las specs Allium futuras como contrato de
  producto; la arquitectura no puede contradecirlas silenciosamente.
- No declarar una capacidad disponible hasta que exista una prueba extremo a
  extremo. El esqueleto responde `501` deliberadamente.
- El relay nunca persiste ni registra payload MCP, secretos, títulos, bloques o
  adjuntos.
- Toda función que toque una solicitud debe probar aislamiento entre al menos
  dos instalaciones.
- Una escritura ambigua no se reintenta automáticamente.
- No desplegar producción, crear recursos Cloudflare, cargar secretos ni cambiar
  DNS sin autorización explícita de Herbert.
- Preservar cambios ajenos y mantener commits pequeños y reversibles.
- Ejecutar `npm run check` antes de cada commit.
