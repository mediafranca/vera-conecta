# Operación

## Objetivos iniciales

- disponibilidad mensual piloto: 99,5 %;
- conexión Desktop detectada como caída en menos de 60 s;
- reconexión automática con backoff y jitter;
- overhead p95 del relay menor a 500 ms, excluida Vera/modelo;
- cero payloads persistidos;
- revocación efectiva en menos de 10 s;
- costo visible y con alerta antes del límite acordado.

Son objetivos a validar, no promesas públicas.

## Estados visibles

La interfaz debe distinguir “Vera desconectada”, “cliente no autorizado”,
“servicio degradado”, “cuota alcanzada” y “resultado incierto”. “Error de red”
no basta para una persona no técnica.

## Runbooks mínimos

### Vera aparece offline

Comprobar heartbeat del DO, versión de conector y reconexiones. No inspeccionar
payload. Si Desktop no está conectado, devolver 503; no encolar solicitudes MCP
ni prometer ejecución posterior.

### Aumento de 401/403

Separar expiración, revocación, reloj desfasado y abuso. Nunca registrar tokens.
No relajar autenticación para recuperar disponibilidad.

### Resultado incierto de escritura

Informar al cliente que debe consultar estado/idempotencia en Vera. No reenviar.
Preservar request ID y clase de operación sin argumentos.

### Incidente de confidencialidad

Cerrar nuevas escrituras, rotar secretos operacionales, preservar metadatos de
auditoría y notificar según la política. El contenido no debería existir en el
relay para ser recuperado.

## Costos

El costo base del piloto es Workers Paid. Se miden requests, CPU de DO,
almacenamiento y duración activa; los WebSockets hibernados no deben mantener
objetos activos. Configurar alertas, no confiar en una estimación fija de US$5.

## Backups

El relay no respalda grafos porque no los guarda. Sí requiere exportación
cifrada del pequeño estado de control o una estrategia verificable de
re-emparejamiento. La pérdida total del relay no puede causar pérdida de Vera;
como máximo obliga a reconectar clientes.
