// pattern: Functional Core

import { describe, it, expect } from "vitest";
import { DataItemParentRefProperty } from "@OpenChart/DiagramModel";

describe("DataItemParentRefProperty", () => {

    it("clone preserves the DataItemParentRefProperty type", () => {
        const prop = new DataItemParentRefProperty(
            { id: "parent", name: "Parent", editable: true },
            "some-guid"
        );
        const cloned = prop.clone();
        expect(cloned.constructor.name).toBe("DataItemParentRefProperty");
        expect(cloned instanceof DataItemParentRefProperty).toBe(true);
        expect(cloned.toJson()).toBe("some-guid");
    });

    it("clone with explicit id uses the provided id", () => {
        const prop = new DataItemParentRefProperty(
            { id: "parent", name: "Parent", editable: true },
            "some-guid"
        );
        const cloned = prop.clone("new-id");
        expect(cloned.id).toBe("new-id");
        expect(cloned instanceof DataItemParentRefProperty).toBe(true);
        expect(cloned.toJson()).toBe("some-guid");
    });

    it("clone of null-value property preserves null", () => {
        const prop = new DataItemParentRefProperty(
            { id: "parent", name: "Parent", editable: true }
        );
        const cloned = prop.clone();
        expect(cloned instanceof DataItemParentRefProperty).toBe(true);
        expect(cloned.toJson()).toBeNull();
    });

});
