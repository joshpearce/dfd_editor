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
 * Requests an automatic layout for a D2 source string.
 * @param source
 *  The D2 source string to lay out.
 * @returns
 *  The rendered SVG string from TALA.
 * @throws
 *  If the request fails, with the backend's error message when available.
 */
export async function layoutDiagram(source: string): Promise<string> {
    const response = await fetch("/api/layout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source })
    });
    if (!response.ok) {
        let message = `layout request failed: ${response.status}`;
        try {
            const body = await response.json() as { error?: string };
            if (body.error) {
                message = `layout request failed: ${body.error}`;
            }
        } catch {
            // response body unreadable — use the status-based message
        }
        throw new Error(message);
    }
    const data = await response.json() as { svg: string };
    return data.svg;
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
