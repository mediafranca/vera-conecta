// La única ruta del Worker de borde que no habla el protocolo del relay: una
// página pública, sin estado, que explica qué es Vera Conecta y qué tan
// avanzado está. No sustituye la documentación técnica en docs/, y no ofrece
// ningún flujo funcional -sería mentir sobre lo que todavía no existe (M2 en
// adelante). docs/03-arquitectura.md la anticipa como «consola mínima
// futura»; esto es su primer peldaño, honesto sobre serlo.

const PAGINA = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vera Conecta</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f7f4ef;
    --text: #241b1f;
    --text-dim: #5f5358;
    --rule: #d8cec8;
    --accent: #701d54;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #1c1218; --text: #ede4e8; --text-dim: #b3a2a9; --rule: #3a2a32; --accent: #e0a6c8; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100dvh;
    display: grid;
    place-items: center;
    background: var(--bg);
    color: var(--text);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    line-height: 1.55;
  }
  main {
    width: min(100% - 2.5rem, 38rem);
    margin: 3rem 0;
  }
  h1 {
    font-size: clamp(1.8rem, 6vw, 2.6rem);
    font-weight: 600;
    margin: 0 0 1rem;
  }
  p { margin: 0 0 1.1rem; color: var(--text-dim); }
  p.lead { color: var(--text); font-size: 1.05rem; }
  .estado {
    margin: 1.75rem 0;
    padding: 1rem 1.25rem;
    border: 1px solid var(--rule);
    border-radius: 0.75rem;
    font-size: 0.92rem;
  }
  .estado strong { color: var(--text); }
  a { color: var(--accent); }
  ul { padding-left: 1.15rem; color: var(--text-dim); }
  li { margin: 0.3rem 0; }
  footer { margin-top: 2rem; font-size: 0.85rem; color: var(--text-dim); }
</style>
</head>
<body>
<main>
  <h1>Vera Conecta</h1>
  <p class="lead">
    El puente opcional entre una instalación local de
    <a href="https://github.com/mediafranca/vera">Vera</a> y los clientes MCP
    que viven en Internet — sin abrir puertos, sin IP pública, sin Tailscale.
  </p>
  <p>
    Vera Desktop inicia la conexión hacia este relay; la persona conserva su
    memoria en su propio equipo. La URL ubica la instalación, nunca autoriza
    por sí sola — hace falta además una credencial revocable por cliente.
  </p>

  <div class="estado">
    <strong>Estado: en construcción, todavía no operativo.</strong>
    <p style="margin: 0.6rem 0 0">
      El enlace de instalación entre Vera Desktop y este relay ya está
      probado de punta a punta. El endpoint MCP remoto que un cliente en la
      nube alcanzaría, y las credenciales por cliente, están especificados
      pero sin implementar: esas rutas responden <code>501</code> a
      propósito, en vez de simular algo que no existe.
    </p>
  </div>

  <p>Mientras tanto:</p>
  <ul>
    <li><a href="https://github.com/mediafranca/vera-conecta">Código y especificaciones de Vera Conecta</a></li>
    <li><a href="https://github.com/mediafranca/vera">Vera</a>, la memoria personal que este relay conecta</li>
  </ul>

  <footer>
    El relay nunca conserva páginas, bloques, adjuntos ni respuestas MCP —
    el contenido vive sólo durante el tránsito.
  </footer>
</main>
</body>
</html>
`;

export function landingResponse(): Response {
  return new Response(PAGINA, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
