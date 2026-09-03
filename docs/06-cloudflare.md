# Cloudflare y despliegue

## Estado previo real

`mediafranca.net` ya está delegado y administrado en la cuenta Cloudflare
existente. Namecheap permanece sólo como registrador. No se cambian nameservers,
no se crea otra cuenta, no se compra PremiumDNS, hosting ni certificado SSL.
Los “Grupos” de Cloudflare son grupos de permisos y no hacen falta para crear el
servicio.

## Servicio a contratar

- Desarrollo local y staging inicial: Workers Free.
- Antes de cualquier beta externa: Workers Paid (base aproximada US$5/mes, más
  excedentes).
- Durable Objects usa almacenamiento SQLite y WebSockets hibernables.
- DNS y TLS del custom domain los gestiona Cloudflare.

## Recursos

- Worker producción: `vera-conecta`.
- Worker staging: `vera-conecta-staging` en `workers.dev`.
- Durable Object exportado: `InstallationRelay`.
- Binding: `INSTALLATIONS`.
- Custom domain: `conecta.mediafranca.net`.
- Sin D1, KV, R2, Queues ni Access en el MVP salvo decisión posterior justificada.

## Preparación local

```sh
cd ~/Sites/vera-conecta
npm install
npx wrangler login
npx wrangler whoami
npm run check
```

`whoami` debe mostrar la cuenta que contiene la zona `mediafranca.net`. No se
guardan API tokens en `.env` ni en el repositorio.

## Staging

```sh
npm run deploy:staging
curl https://vera-conecta-staging.<subdominio>.workers.dev/health
```

Staging permanece en `workers.dev` para no crear un nombre que después parezca
producción. No recibe datos personales reales.

## Producción

1. Revisar `wrangler.jsonc` y el diff del despliegue.
2. Activar Workers Paid.
3. Cargar secretos individualmente:

   ```sh
   npx wrangler secret put VERA_CONECTA_ADMIN_SECRET
   npx wrangler secret put VERA_CONECTA_TOKEN_PEPPER
   ```

4. Ejecutar suite, prueba de aislamiento y prueba de revocación.
5. `npm run deploy:production`.
6. Cloudflare crea/gestiona el DNS y certificado por la ruta
   `custom_domain: true` para `conecta.mediafranca.net`.
7. Verificar TLS, `/health`, que rutas no implementadas estén cerradas y que no
   exista un CNAME manual conflictivo.

No desplegar desde una estación sucia ni desde `main` sin commit. El primer
despliegue productivo requiere confirmación explícita de Herbert.

## Observabilidad y privacidad

La configuración inicial deja la observabilidad de Wrangler apagada. Antes de
producción se debe diseñar muestreo y filtros que garanticen ausencia de payload;
recién entonces se habilita. No activar Logpush indiscriminadamente. Alertas mínimas: errores 5xx, 429, objetos
sin Desktop, reconexiones, latencia p95, CPU y gasto.


## Límites de plataforma que influyen

Workers dispone de 128 MB por isolate; los cuerpos deben transmitirse y
fragmentarse. En Free hay 100.000 solicitudes/día y 10 ms CPU por request; Paid
elimina ese tope diario y permite más CPU. Los request bodies dependen del plan
de zona, pero Vera Conecta impone 10 MiB inicialmente.

## Rollback

Registrar cada despliegue, conservar la versión previa y probar rollback con
`wrangler versions`. Los cambios de esquema del Durable Object deben ser
compatibles hacia atrás durante al menos una versión. Nunca borrar la clase o su
storage para “arreglar” un deploy.
