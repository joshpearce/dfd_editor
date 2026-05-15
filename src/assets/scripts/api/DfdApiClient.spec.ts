import { afterEach, describe, it, expect, vi } from "vitest";
import { nativeLayout } from "./DfdApiClient";

type FetchResponse = {
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
};

function makeFetch(response: FetchResponse) {
    return vi.fn().mockResolvedValue(response);
}

describe("nativeLayout", () => {
    const doc = { objects: [], schema: "x" };

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("resolves with the position map on a successful response", async () => {
        const layout = { abc: [10, 20] as [number, number], def: [30, 40] as [number, number] };
        const fetchMock = makeFetch({ ok: true, status: 200, json: async () => ({ layout }) });
        vi.stubGlobal("fetch", fetchMock);

        const result = await nativeLayout(doc);

        expect(result).toEqual(layout);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/native-layout",
            expect.objectContaining({
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(doc)
            })
        );
    });

    it("rejects with the backend error message on a non-2xx response with readable body", async () => {
        const fetchMock = makeFetch({
            ok: false,
            status: 502,
            json: async () => ({ error: "boom from backend" })
        });
        vi.stubGlobal("fetch", fetchMock);

        await expect(nativeLayout({})).rejects.toThrow(
            "native layout request failed: boom from backend"
        );
    });

    it("rejects with a status-based message when the error body is unreadable", async () => {
        const fetchMock = makeFetch({
            ok: false,
            status: 500,
            json: async () => { throw new Error("not json"); }
        });
        vi.stubGlobal("fetch", fetchMock);

        await expect(nativeLayout({})).rejects.toThrow(
            "native layout request failed: 500"
        );
    });

    it("resolves with an empty map when the server returns an empty layout", async () => {
        const fetchMock = makeFetch({ ok: true, status: 200, json: async () => ({ layout: {} }) });
        vi.stubGlobal("fetch", fetchMock);

        const result = await nativeLayout(doc);

        expect(result).toEqual({});
    });
});
