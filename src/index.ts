import { DurableObject } from "cloudflare:workers";

export interface Env {
  INSTALLATIONS: DurableObjectNamespace<InstallationRelay>;
}

function json(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json(200, { service: "vera-conecta", status: "design-skeleton" });
    }
    return json(501, {
      error: "not_implemented",
      detail: "El relay permanece cerrado hasta que sus contratos estén especificados y probados.",
    });
  },
} satisfies ExportedHandler<Env>;

export class InstallationRelay extends DurableObject<Env> {
  async fetch(): Promise<Response> {
    return json(501, { error: "relay_not_implemented" });
  }
}
