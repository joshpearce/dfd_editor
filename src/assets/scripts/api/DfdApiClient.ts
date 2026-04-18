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

/**
 * Fetches a diagram from the server projected to the minimal DFD format.
 * @param id
 *  The diagram's ID.
 * @returns
 *  The minimal JSON document as a string.
 * @throws
 *  If the request fails.
 */
export async function exportMinimalDiagram(id: DiagramId): Promise<string> {
    const response = await fetch(`/api/diagrams/${id}/export`);
    if (!response.ok) {
        let message = `Failed to export diagram '${id}': ${response.status}`;
        try {
            const body = await response.json() as { error?: string, detail?: string };
            if (body.error) {
                message = body.detail ? `${body.error}: ${body.detail}` : body.error;
            }
        } catch {
            // body unreadable — keep status-based message
        }
        throw new Error(message);
    }
    return await response.text();
}

/**
 * Imports a minimal DFD JSON document to the server; server validates it
 * via pydantic, converts it to the native dfd_v1 shape, and persists it.
 * @param minimal
 *  The minimal JSON document (already parsed into a JS value).
 * @returns
 *  The imported diagram's ID.
 * @throws
 *  If validation fails (400) or the request fails. The error message
 *  includes the server's `error` field and pydantic `details` when present.
 */
export async function importMinimalDiagram(minimal: unknown): Promise<DiagramId> {
    const response = await fetch("/api/diagrams/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(minimal)
    });
    if (!response.ok) {
        let message = `Import failed: ${response.status}`;
        try {
            const body = await response.json() as {
                error?: string;
                detail?: string;
                details?: { loc?: (string | number)[], msg?: string }[];
            };
            if (body.error) {
                message = body.error;
                if (body.detail) {
                    message += `: ${body.detail}`;
                } else if (body.details && body.details.length) {
                    const first = body.details[0];
                    const loc = (first.loc ?? []).join(".");
                    message += ` at ${loc || "<root>"}: ${first.msg ?? ""}`;
                }
            }
        } catch {
            // body unreadable — keep status-based message
        }
        throw new Error(message);
    }
    const data = await response.json() as { id: DiagramId };
    return data.id;
}
