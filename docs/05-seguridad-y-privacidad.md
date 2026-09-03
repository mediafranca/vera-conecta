# Seguridad y privacidad

## Fronteras de confianza

Internet, Cloudflare, el operador, Vera Desktop, Vera local y el proveedor de IA
son fronteras distintas. TLS protege el tránsito, pero Cloudflare está en la
ruta; la promesa correcta es minimización y no persistencia, no cifrado de
extremo a extremo invisible al relay en el MVP.

## Credenciales separadas

- ID público: enrutamiento, no secreto.
- Secreto de enlace: sólo Desktop↔relay.
- Token/OAuth de cliente: sólo cliente↔relay.
- Credencial Vera local: permanece en Desktop y atribuye operaciones.
- Secretos operacionales: `wrangler secret put`, nunca variables de texto en Git.

Tokens se generan con al menos 256 bits, se muestran una vez y se almacenan como
hash resistente con pepper operacional. Los logs muestran como máximo un prefijo
no reversible o un ID derivado.

## Amenazas mínimas que la spec debe cubrir

- enumeración de IDs públicos;
- robo/reutilización de bearer;
- DNS rebinding y `Origin` hostil;
- conexión Desktop impostora;
- replay de emparejamiento o sobres;
- confusión entre dos instalaciones o dos participantes;
- elevación de alcance entre relay y Vera;
- duplicación de escrituras al reconectar;
- payload, encabezados o errores filtrados a logs;
- agotamiento de memoria, CPU, sockets o solicitudes en vuelo;
- operador o dependencia comprometida;
- despliegue defectuoso y rollback;
- eliminación incompleta tras revocación.

## Controles

Entropía alta, rate limiting por instalación/cliente/IP, expiración, nonces,
comparación constante, listas de cabeceras permitidas, límites antes de
deserializar, streaming, timeouts, revocación inmediata, CSP estricta en futuras
pantallas, dependencia fijada por lockfile y CI con auditoría.

El conector local sólo llama a loopback y nunca acepta una credencial/participante
propuesto por el payload. La asociación remoto→credencial Vera vive localmente.

## Registros

Se permiten: IDs operacionales pseudónimos, tiempos, bytes, clase de operación,
código de estado, versión, latencia y región. Se prohíben cuerpos, argumentos,
resultados, títulos, tokens, cookies y cabeceras libres. Retención inicial: 14
días para eventos detallados y 90 días para métricas agregadas; decisión abierta
que debe confirmarse jurídicamente.

## Respuesta y borrado

Revocar invalida acceso inmediatamente. Eliminar una instalación borra estado y
tokens del Durable Object tras un periodo de recuperación aún por decidir. Debe
existir evidencia de borrado sin conservar el contenido borrado. Incidentes que
puedan afectar confidencialidad suspenden escrituras antes que disponibilidad.

## Puertas antes de terceros

- modelo de amenazas revisado externamente;
- OAuth 2.1 y consentimiento explícito;
- prueba de aislamiento entre instalaciones;
- rotación y revocación ensayadas;
- política de privacidad y tratamiento de datos;
- límites y alertas de costo;
- recuperación y rollback de despliegue;
- evaluación de la Ley 21.719 y roles de tratamiento.
