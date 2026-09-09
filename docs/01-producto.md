# Alcance y producto

## En una frase

Vera Conecta permite que clientes remotos autorizados —agentes MCP o
aplicaciones estrechas como Vera Clip— lleguen a una instalación local de Vera
mediante una conexión saliente que Vera mantiene hacia un relay administrado
por MediaFranca.

## Problema

ChatGPT, Claude y otros clientes ejecutados en la nube no pueden llamar al
`localhost` de una persona detrás de NAT. Pedir a cada persona una IP pública,
Tailscale, terminal, certificado o túnel propio contradice la experiencia de
Vera. Vera Conecta ofrece una puerta pública estable sin publicar toda Vera.

## Incluye

- registro y emparejamiento de una instalación Vera Desktop;
- ID público opaco de instalación;
- canal saliente persistente entre Desktop y el relay;
- endpoint MCP remoto estable por instalación;
- canal HTTP de captura para Vera Clip, separado del acceso MCP genérico;
- credenciales separadas por cliente, revocables y con alcances;
- transporte de solicitudes/respuestas MCP sin persistir su contenido;
- estado visible: conectada, desconectada, degradada o revocada;
- límites, auditoría operacional sin contenido y recuperación de conexión;
- OAuth 2.1 para el producto abierto a terceros.

## Excluye

- alojar el grafo o una réplica de Vera;
- alojar OpenClaw, Hermes, modelos o conversaciones;
- publicar la interfaz humana privada de Vera;
- sincronizar dos instalaciones Vera;
- editar el grafo por una ruta distinta de las operaciones canónicas de Vera;
- convertir el relay en una API general para cualquier aplicación;
- garantizar compatibilidad MCP con una aplicación que no admita MCP remoto;
- pagos, planes comerciales y administración multi-organización en el MVP.

## Principios no negociables

1. **La URL ubica; una credencial autoriza.** Conocer el ID público no concede
   acceso.
2. **Vera inicia la conexión.** Nunca se abre un puerto doméstico.
3. **El relay no es memoria.** El contenido vive sólo durante el tránsito.
4. **Una identidad por cliente.** Revocar Claude no desconecta ChatGPT.
5. **La autoridad final vive en Vera.** El conector local traduce una identidad
   remota a una credencial Vera de alcance igual o menor.
6. **Apagado significa cerrado.** Con Vera Desktop desconectada no existe una
   copia servible del grafo.
7. **El fallo es explícito.** Nunca se confirma una escritura cuyo resultado sea
   incierto.

## Éxito del piloto

Una persona no técnica instala Vera, activa “Conectar una IA”, copia o autoriza
una URL en un cliente compatible, verifica la identidad del agente, consulta su
memoria y revoca el acceso sin terminal. Ningún contenido queda en logs o
almacenamiento del relay.
