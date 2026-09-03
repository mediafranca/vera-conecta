export type ClaseDeOperacion = "lectura" | "escritura";
export type Alcance = "read" | "write" | "delete";

// specs/mcp-relay.allium: "la clase se deriva del método MCP, no de su
// contenido". tools/call es la única superficie de escritura del protocolo:
// el relay no puede ver qué herramienta se invoca sin abrir el contenido, así
// que trata cualquier tools/call como escritura y exige el alcance write. El
// cerco fino de qué puede borrar o escribir un cliente lo aplica Vera local
// (specs/client-grants.allium, contrato TraduccionDeAlcance).
const METODOS_DE_LECTURA = new Set([
  "initialize",
  "ping",
  "tools/list",
  "resources/list",
  "resources/read",
  "resources/templates/list",
  "resources/subscribe",
  "resources/unsubscribe",
  "prompts/list",
  "prompts/get",
  "completion/complete",
  "logging/setLevel",
]);

export function clasificarMetodo(method: string): { clase: ClaseDeOperacion; alcance_requerido: Alcance } | null {
  if (METODOS_DE_LECTURA.has(method)) return { clase: "lectura", alcance_requerido: "read" };
  if (method === "tools/call") return { clase: "escritura", alcance_requerido: "write" };
  return null;
}

// specs/04-protocolo.md: lista explícita de orígenes conocidos, o ausencia de
// Origin para clientes nativos. Nunca se refleja un origen arbitrario.
export function origenAdmitido(request: Request, origenesPermitidos: readonly string[]): boolean {
  const origen = request.headers.get("Origin");
  if (!origen) return true;
  return origenesPermitidos.includes(origen);
}
