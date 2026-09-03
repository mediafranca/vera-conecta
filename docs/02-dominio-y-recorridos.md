# Modelo de dominio y recorridos

## Actores

- **Persona propietaria:** controla su Vera y autoriza clientes.
- **Vera Desktop:** aloja el grafo local y el conector.
- **Cliente MCP:** ChatGPT, Claude, Hermes u otra aplicación compatible.
- **Vera Conecta:** enruta y aplica autenticación/límites.
- **Vera local:** valida permisos y ejecuta herramientas/operaciones.
- **Operador MediaFranca:** despliega y observa salud, nunca contenido.

## Entidades

- **Instalación:** identidad durable de una Vera Desktop.
- **ID público:** cadena aleatoria de al menos 128 bits, prefijo `vr_`; enruta.
- **Enlace:** asociación vigente entre una instalación y el relay.
- **Secreto de enlace:** autentica sólo el canal Desktop↔relay; no sirve para MCP.
- **Cliente autorizado:** identidad separada por aplicación/dispositivo.
- **Concesión:** alcances y vigencia otorgados a un cliente.
- **Sesión MCP:** continuidad de transporte según MCP Streamable HTTP.
- **Solicitud en tránsito:** sobre efímero con ID, método, cabeceras permitidas y
  fragmentos del cuerpo.
- **Evento operativo:** metadato sin payload para disponibilidad y abuso.

## Estados principales

```text
Instalación: no_registrada -> emparejando -> conectada <-> desconectada
                                      |             |
                                      +-> revocada <-+

Cliente: pendiente -> autorizado -> revocado | expirado

Solicitud: recibida -> autenticada -> entregada -> respondida
                  |          |            |-> resultado_incierto
                  |          +-> vera_desconectada
                  +-> rechazada
```

## Recorrido principal

1. Vera Desktop solicita iniciar emparejamiento.
2. El relay emite un desafío breve, de un solo uso y expiración corta.
3. Desktop demuestra posesión del desafío y recibe ID público + secreto de
   enlace. El secreto queda en el almacén seguro del sistema operativo.
4. Desktop abre `wss://conecta.mediafranca.net/v/<id>/link`.
5. La persona crea una autorización para un cliente.
6. El cliente conecta a `/v/<id>/mcp` y presenta OAuth o bearer del piloto.
7. El Worker valida forma, origen, límites y credencial; el Durable Object
   comprueba que la instalación está enlazada.
8. La solicitud se transmite al conector local con una identidad derivada.
9. El conector selecciona la credencial Vera local correspondiente y llama al
   MCP local por loopback.
10. La respuesta vuelve por el mismo canal y se transmite al cliente.

## Revocación

La persona revoca un cliente en Vera Desktop. Desktop elimina o suspende la
credencial local y comunica la revocación al relay. Desde ese instante el token
remoto deja de autenticar, pero el enlace de la instalación y los otros clientes
siguen activos.

## Rotación y pérdida

- Rotar secreto de enlace invalida el anterior tras una ventana breve de
  solapamiento confirmada por Desktop.
- Regenerar el ID público corta todas las URLs anteriores.
- Reinstalar Vera exige recuperación deliberada o una instalación nueva; nunca
  se adopta una identidad sólo por conocer su ID público.
- Si dos procesos presentan el mismo enlace, la conexión nueva desplaza a la
  anterior y queda un evento operacional.

## Decisiones todavía abiertas

- Proveedor de identidad inicial para OAuth: cuenta Vera propia, Cloudflare
  Access o proveedor externo.
- Duración de tokens, códigos de emparejamiento y solapamiento de rotación.
- Si el primer piloto admite escritura o comienza estrictamente en lectura.
- Qué clientes MCP concretos forman la matriz de compatibilidad v1.
