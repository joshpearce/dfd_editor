export type DiagramId = string;

export interface DiagramSummary {
    id: DiagramId;
    name: string;
    modified: number;
}

/**
 * Lists the diagrams stored on the server.
 * @returns
 *  The diagram summaries, sorted by id.
 * @throws
 *  If the request fails.
 */
export async function listDiagrams(): Promise<DiagramSummary[]> {
    const response = await fetch("/api/diagrams");
    if (!response.ok) {
        throw new Error(`Failed to list diagrams: ${response.status}`);
    }
    return await response.json() as DiagramSummary[];
}

/**
 * Fetches a diagram from the server.
 * @param id
 *  The diagram's ID.
 * @returns
 *  The serialized diagram JSON.
 * @throws
 *  If the request fails.
 */
export async function getDiagram(id: DiagramId): Promise<string> {
    const response = await fetch(`/api/diagrams/${id}`);
    if (!response.ok) {
        throw new Error(`Failed to fetch diagram '${id}': ${response.status}`);
    }
    return await response.text();
}

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
