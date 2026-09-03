# ADR 0002: el relay no almacena el grafo

Estado: aceptada.

Vera Conecta persiste sólo estado de control. Las páginas, bloques, adjuntos,
prompts y respuestas atraviesan memoria efímera y no aparecen en logs. Si Vera
Desktop está apagada, el contenido no está disponible.

Esto sacrifica funcionamiento offline del conector cloud y colas diferidas, pero
preserva la frontera soberana de Vera y reduce el impacto de una intrusión.
