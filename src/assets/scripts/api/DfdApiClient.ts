export type DiagramId = string;

/**
 * Saves a diagram to the server.
 * @param id
 *  The diagram's ID.
 * @param payload
 *  The serialized diagram JSON.
 * @throws
 *  If the request fails.
 */
export async function saveDiagram(id: DiagramId, payload: string): Promise<void> {
    const response = await fetch(`/api/diagrams/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: payload
    });
    if (!response.ok) {
        throw new Error(`Failed to save diagram '${id}': ${response.status}`);
    }
}

/**
 * Creates a new diagram on the server.
 * @returns
 *  The new diagram's ID.
 * @throws
 *  If the request fails.
 */
export async function createDiagram(): Promise<DiagramId> {
    const response = await fetch("/api/diagrams", { method: "POST" });
    if (!response.ok) {
        throw new Error(`Failed to create diagram: ${response.status}`);
    }
    const data = await response.json() as { id: DiagramId };
    return data.id;
}
