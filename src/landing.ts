function pagina(hostname: string): string {
  const produccion = hostname === "conecta.mediafranca.net";
  const estado = produccion ? "Servicio comunitario disponible" : "Entorno de prueba activo";
  const detalle = produccion
    ? "Este origen enlaza instalaciones Vera con clientes MCP autorizados por sus propietarias."
    : "Este origen verifica el servicio antes de su publicación. No debe usarse todavía con bibliotecas reales.";

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Vera Conecta</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #e6ebe9;
    --bg-raised: #e8ebf1;
    --text: #454f6e;
    --text-dim: #6b7080;
    --rule: #d1d1d2;
    --accent: #a84a0b;
    font-family: "IBM Plex Sans", system-ui, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #2e0024;
      --bg-raised: #351725;
      --text: #cde0cf;
      --text-dim: #a4a696;
      --rule: #24001c;
      --accent: #ee895d;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-size: 1rem;
    line-height: 1.55;
  }
  main {
    width: min(100% - 2rem, 62rem);
    margin: 0 auto;
    padding: clamp(3rem, 9vw, 8rem) 0 3rem;
  }
  header { max-width: 49rem; }
  h1 {
    margin: 0 0 1.25rem;
    font-size: clamp(2.4rem, 8vw, 5.7rem);
    font-weight: 400;
    letter-spacing: -0.045em;
    line-height: 0.95;
  }
  .lead {
    max-width: 42rem;
    margin: 0;
    font-size: clamp(1.16rem, 2.5vw, 1.5rem);
    line-height: 1.38;
  }
  .status {
    display: grid;
    grid-template-columns: minmax(10rem, 1fr) 3fr;
    gap: 1.5rem;
    margin: clamp(3rem, 7vw, 6rem) 0 0;
    padding: 1rem 0;
    border-block: 1px solid var(--rule);
    background: var(--bg-raised);
  }
  .status p { margin: 0; padding-inline: 1rem; }
  .status strong { font-weight: 600; }
  .sections {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0;
    margin-top: 4rem;
    border-top: 1px solid var(--rule);
  }
  section {
    min-width: 0;
    padding: 1.25rem 1.5rem 2rem 0;
    border-bottom: 1px solid var(--rule);
  }
  section + section { padding-left: 1.5rem; border-left: 1px solid var(--rule); }
  h2 {
    margin: 0 0 1rem;
    color: var(--text-dim);
    font-size: 0.78rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  p { margin: 0 0 1rem; }
  a { color: var(--accent); text-underline-offset: 0.18em; }
  footer {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem 1.5rem;
    margin-top: 3rem;
    color: var(--text-dim);
    font-size: 0.875rem;
  }
  footer a { color: inherit; }
  @media (max-width: 44rem) {
    .status { grid-template-columns: 1fr; gap: 0.5rem; }
    .sections { grid-template-columns: 1fr; }
    section, section + section { padding: 1.25rem 0; border-left: 0; }
  }
</style>
</head>
<body>
<main>
  <header>
    <h1>Vera Conecta</h1>
    <p class="lead">Un puente opcional entre una Vera que permanece en tu equipo y los clientes MCP que viven en Internet.</p>
  </header>

  <div class="status" aria-label="Estado del servicio">
    <p><strong>${estado}</strong></p>
    <p>${detalle}</p>
  </div>

  <div class="sections">
    <section>
      <h2>Cómo funciona</h2>
      <p>Vera Desktop abre una conexión saliente cifrada. No exige IP pública, puertos abiertos ni una cuenta de Cloudflare por persona.</p>
    </section>
    <section>
      <h2>Qué permanece local</h2>
      <p>El corpus, sus objetos, su historia y las claves de los modelos permanecen en la Vera de su propietaria. El relay no los almacena.</p>
    </section>
    <section>
      <h2>La URL no autoriza</h2>
      <p>Cada cliente necesita una credencial separada y revocable. Conocer la dirección pública de una instalación no permite leerla ni modificarla.</p>
    </section>
  </div>

  <footer>
    <a href="https://vera.mediafranca.net/vera-conecta/">Acerca de Vera Conecta</a>
    <a href="https://github.com/mediafranca/vera-conecta">Código y especificaciones</a>
    <a href="https://github.com/mediafranca/vera">Proyecto Vera</a>
  </footer>
</main>
</body>
</html>`;
}

export function landingResponse(hostname: string): Response {
  return new Response(pagina(hostname), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}
