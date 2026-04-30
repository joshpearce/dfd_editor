import type { Cursor } from "@OpenChart/DiagramInterface";
import type { HitTarget } from "@OpenChart/DiagramView";

export type CursorMap = {
    [key: string]: (o: HitTarget) => Cursor;
};
