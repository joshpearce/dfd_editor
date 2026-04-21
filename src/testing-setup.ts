/**
 * Setup file for jsdom tests.
 * Mocks canvas context and Pinia spy before any modules are imported.
 */

import { vi } from "vitest";

// Configure @pinia/testing to use vitest's createSpy
if (typeof HTMLCanvasElement !== "undefined") {
    const mockPattern: Record<string, unknown> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    HTMLCanvasElement.prototype.getContext = function(): any {
        return {
            fillRect: () => {},
            clearRect: () => {},
            getImageData: () => ({ data: [] }),
            putImageData: () => {},
            setTransform: () => {},
            drawImage: () => {},
            save: () => {},
            restore: () => {},
            scale: () => {},
            rotate: () => {},
            translate: () => {},
            transform: () => {},
            font: "",
            measureText: () => ({ width: 0 }),
            fillText: () => {},
            strokeText: () => {},
            createPattern: () => mockPattern,
            createLinearGradient: () => mockPattern,
            createRadialGradient: () => mockPattern,
            createImageData: () => ({ data: [] }),
            getLineDash: () => [],
            setLineDash: () => {},
            lineDashOffset: 0,
            fillStyle: "",
            strokeStyle: "",
            lineWidth: 1,
            lineCap: "butt",
            lineJoin: "miter",
            globalAlpha: 1
        };
    };
}

// Export createSpy for pinia/testing
export { vi };
