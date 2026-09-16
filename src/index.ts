import { InstallationRelay, type Env } from "./installation-relay";
import { landingResponse } from "./landing";

export type { Env };
export { InstallationRelay };

const PAIRING_OBJECT_NAME = "pairing";

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json(200, { service: "vera-conecta", status: "design-skeleton" });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return landingResponse();
    }

    if (request.method === "POST" && url.pathname === "/pairings") {
      const bodyText = await request.text();
      const pairing = env.INSTALLATIONS.get(env.INSTALLATIONS.idFromName(PAIRING_OBJECT_NAME));
      return pairing.fetch(
        new Request("http://do/internal/pairings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: bodyText,
        }),
      );
    }

    const claimMatch = url.pathname.match(/^\/pairings\/([^/]+)\/claim$/);
    if (request.method === "POST" && claimMatch) {
      const codigo = decodeURIComponent(claimMatch[1]);
      const pairing = env.INSTALLATIONS.get(env.INSTALLATIONS.idFromName(PAIRING_OBJECT_NAME));
      return pairing.fetch(
        new Request("http://do/internal/pairings/claim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ codigo }),
        }),
      );
    }

    const linkMatch = url.pathname.match(/^\/v\/([^/]+)\/link$/);
    if (request.method === "GET" && linkMatch) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return json(400, { error: "se_esperaba_websocket" });
      }
      const idPublico = decodeURIComponent(linkMatch[1]);
      const installation = env.INSTALLATIONS.get(env.INSTALLATIONS.idFromName(idPublico));
      const target = new URL("http://do/internal/link");
      target.search = url.search;
      return installation.fetch(new Request(target, request));
    }

    const controlMatch = url.pathname.match(/^\/v\/([^/]+)\/(rotate|rotate\/confirm|revoke)$/);
    if (request.method === "POST" && controlMatch) {
      const idPublico = decodeURIComponent(controlMatch[1]);
      const bodyText = await request.text();
      const installation = env.INSTALLATIONS.get(env.INSTALLATIONS.idFromName(idPublico));
      return installation.fetch(
        new Request(`http://do/internal/${controlMatch[2]}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: bodyText,
        }),
      );
    }

    const clientsMatch = url.pathname.match(/^\/v\/([^/]+)\/clients$/);
    if (clientsMatch && (request.method === "POST" || request.method === "GET")) {
      const idPublico = decodeURIComponent(clientsMatch[1]);
      const installation = env.INSTALLATIONS.get(env.INSTALLATIONS.idFromName(idPublico));
      if (request.method === "GET") {
        return installation.fetch(new Request("http://do/internal/clients"));
      }
      const bodyText = await request.text();
      return installation.fetch(
        new Request("http://do/internal/clients", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: bodyText,
        }),
      );
    }

    const clientActionMatch = url.pathname.match(/^\/v\/([^/]+)\/clients\/([^/]+)\/(claim|refresh|revoke)$/);
    if (request.method === "POST" && clientActionMatch) {
      const idPublico = decodeURIComponent(clientActionMatch[1]);
      const principalId = decodeURIComponent(clientActionMatch[2]);
      const bodyText = await request.text();
      const installation = env.INSTALLATIONS.get(env.INSTALLATIONS.idFromName(idPublico));
      return installation.fetch(
        new Request(`http://do/internal/clients/${encodeURIComponent(principalId)}/${clientActionMatch[3]}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: bodyText,
        }),
      );
    }

    const mcpMatch = url.pathname.match(/^\/v\/([^/]+)\/mcp$/);
    if (mcpMatch && (request.method === "POST" || request.method === "DELETE")) {
      const idPublico = decodeURIComponent(mcpMatch[1]);
      const installation = env.INSTALLATIONS.get(env.INSTALLATIONS.idFromName(idPublico));
      const target = new URL("http://do/internal/mcp");
      return installation.fetch(new Request(target, request));
    }

    const capturesMatch = url.pathname.match(/^\/v\/([^/]+)\/captures$/);
    if (request.method === "POST" && capturesMatch) {
      const idPublico = decodeURIComponent(capturesMatch[1]);
      const installation = env.INSTALLATIONS.get(env.INSTALLATIONS.idFromName(idPublico));
      return installation.fetch(new Request("http://do/internal/captures", request));
    }

    const servicioMatch = url.pathname.match(/^\/v\/([^/]+)\/servicio$/);
    if (request.method === "POST" && servicioMatch) {
      const idPublico = decodeURIComponent(servicioMatch[1]);
      const bodyText = await request.text();
      const installation = env.INSTALLATIONS.get(env.INSTALLATIONS.idFromName(idPublico));
      return installation.fetch(
        new Request("http://do/internal/servicio", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: bodyText,
        }),
      );
    }

    return json(501, {
      error: "not_implemented",
      detail: "El relay permanece cerrado hasta que sus contratos estén especificados y probados.",
    });
  },
} satisfies ExportedHandler<Env>;
