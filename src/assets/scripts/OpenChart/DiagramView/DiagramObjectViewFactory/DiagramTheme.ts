import type { FaceDesign } from "./FaceDesign";

export type DiagramTheme = {

    /**
     * The theme's identifier.
     */
    id: string;

    /**
     * The theme's name.
     */
    name: string;

    /**
     * The theme's layout grid — used by face renderers (text padding,
     * anchor offsets, etc.). Should usually stay small (e.g. 5).
     */
    grid: [number, number];

    /**
     * The drag-snap step. Quantizes drag/resize deltas. When omitted,
     * falls back to {@link grid} so existing themes behave unchanged.
     */
    snapGrid?: [number, number];

    /**
     * The theme's interface scale.
     */
    scale: number;

    /**
     * The theme's designs.
     */
    designs: {

        [key: string]: FaceDesign;

    };

};
