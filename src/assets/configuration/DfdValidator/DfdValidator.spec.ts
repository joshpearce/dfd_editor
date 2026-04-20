/**
 * @file DfdValidator.spec.ts
 *
 * Tests for DfdValidator's `data_item_refs` dangling-ref warning introduced
 * in Step 5 of the data-items-on-canvas plan.
 *
 * SCOPE: Only the dangling-ref validator behaviour is tested here.  Existing
 * validation rules (required fields, trust-boundary constraints, edge auth)
 * are intentionally left to integration / manual verification to avoid
 * duplicating tests for already-established behaviour.
 */

import { describe, it, expect, beforeEach } from "vitest";
import DfdValidator from "./DfdValidator";
import {
    DiagramObjectFactory, DiagramModelFile, Line, Block, StringProperty
} from "@OpenChart/DiagramModel";
import { DfdCanvas } from "../DfdTemplates/DfdCanvas";
import { DfdObjects } from "../DfdTemplates/DfdObjects";
import { BaseTemplates } from "../DfdTemplates/BaseTemplates";
import { addDataItem, addDataItemRef } from "../DfdTemplates/dataItems.test-utils";
import type { DiagramSchemaConfiguration, DiagramObject } from "@OpenChart/DiagramModel";

// ---------------------------------------------------------------------------
// Schema + factory shared by all tests
// ---------------------------------------------------------------------------

const dfdSchema: DiagramSchemaConfiguration = {
    id: "dfd_v1",
    canvas: DfdCanvas,
    templates: [...BaseTemplates, ...DfdObjects]
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Connects a flow line's source/target latches to block anchors. */
function connect(line: Line, src: Block, trg: Block): void {
    const srcAnchor = [...src.anchors.values()][0];
    const trgAnchor = [...trg.anchors.values()][0];
    line.source.link(srcAnchor);
    line.target.link(trgAnchor);
}

/** Sets the required `name` string property on a diagram object. */
function setName(obj: DiagramObject, name: string): void {
    (obj.properties.value.get("name") as StringProperty).setValue(name);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DfdValidator — data_item_refs dangling-ref warning (Step 5)", () => {

    let factory: DiagramObjectFactory;
    let validator: DfdValidator;

    beforeEach(() => {
        factory = new DiagramObjectFactory(dfdSchema);
        validator = new DfdValidator();
    });

    // -----------------------------------------------------------------------
    // 1. Valid ref — no warning
    // -----------------------------------------------------------------------

    describe("valid ref", () => {

        it("does not emit a warning when all refs resolve to known data items", () => {
            const file = new DiagramModelFile(factory);
            const canvas = file.canvas;
            const procA = factory.createNewDiagramObject("process", Block);
            const procB = factory.createNewDiagramObject("process", Block);
            canvas.addObject(procA);
            canvas.addObject(procB);

            const flow = factory.createNewDiagramObject("data_flow", Line);
            canvas.addObject(flow);
            connect(flow, procA, procB);

            // Add a valid data item and reference it from the flow
            addDataItem(canvas, "item-1", procA.instance, "D1", "My Item", undefined, "pii");
            addDataItemRef(flow, "item-1");

            // Set required fields to avoid unrelated errors
            setName(procA, "ProcA");
            setName(procB, "ProcB");
            setName(flow, "Flow1");

            validator.run(file);

            const warnings = validator.getWarnings();
            const danglingWarnings = warnings.filter(w => w.reason.includes("unknown data item"));
            expect(danglingWarnings).toHaveLength(0);
        });

    });

    // -----------------------------------------------------------------------
    // 2. Dangling ref — warning emitted
    // -----------------------------------------------------------------------

    describe("dangling ref", () => {

        it("emits a warning (not an error) for a ref that doesn't match any data item", () => {
            const file = new DiagramModelFile(factory);
            const canvas = file.canvas;
            const procA = factory.createNewDiagramObject("process", Block);
            const procB = factory.createNewDiagramObject("process", Block);
            canvas.addObject(procA);
            canvas.addObject(procB);

            const flow = factory.createNewDiagramObject("data_flow", Line);
            canvas.addObject(flow);
            connect(flow, procA, procB);

            // Add a VALID data item to the canvas
            addDataItem(canvas, "item-1", procA.instance, "D1", "My Item");
            // Add a DANGLING ref (not in canvas data_items)
            addDataItemRef(flow, "dangling-guid-xyz");

            setName(procA, "ProcA");
            setName(procB, "ProcB");
            setName(flow, "Flow1");

            validator.run(file);

            // Warning, not error
            const warnings = validator.getWarnings();
            const errors = validator.getErrors();
            const danglingWarnings = warnings.filter(w => w.reason.includes("unknown data item"));
            expect(danglingWarnings).toHaveLength(1);
            expect(danglingWarnings[0].reason).toContain("dangling-guid-xyz");

            // Must not have been added to errors
            const danglingErrors = errors.filter(e => e.reason.includes("unknown data item"));
            expect(danglingErrors).toHaveLength(0);
        });

        it("does not block validation — inValidState() is true even with dangling refs", () => {
            const file = new DiagramModelFile(factory);
            const canvas = file.canvas;
            const procA = factory.createNewDiagramObject("process", Block);
            const procB = factory.createNewDiagramObject("process", Block);
            canvas.addObject(procA);
            canvas.addObject(procB);

            const flow = factory.createNewDiagramObject("data_flow", Line);
            canvas.addObject(flow);
            connect(flow, procA, procB);

            addDataItem(canvas, "item-1", procA.instance, "D1", "My Item");
            addDataItemRef(flow, "dangling-guid-xyz");

            setName(procA, "ProcA");
            setName(procB, "ProcB");
            setName(flow, "Flow1");

            validator.run(file);

            // Dangling ref must not produce an error that blocks save/publish
            expect(validator.inValidState()).toBe(true);
        });

        it("emits one warning per dangling ref (multiple dangling refs)", () => {
            const file = new DiagramModelFile(factory);
            const canvas = file.canvas;
            const procA = factory.createNewDiagramObject("process", Block);
            const procB = factory.createNewDiagramObject("process", Block);
            canvas.addObject(procA);
            canvas.addObject(procB);

            const flow = factory.createNewDiagramObject("data_flow", Line);
            canvas.addObject(flow);
            connect(flow, procA, procB);

            addDataItem(canvas, "item-1", procA.instance, "D1", "My Item");
            // Two dangling refs
            addDataItemRef(flow, "dangling-a");
            addDataItemRef(flow, "dangling-b");

            setName(procA, "ProcA");
            setName(procB, "ProcB");
            setName(flow, "Flow1");

            validator.run(file);

            const danglingWarnings = validator.getWarnings().filter(
                w => w.reason.includes("unknown data item")
            );
            expect(danglingWarnings).toHaveLength(2);
        });

    });

    // -----------------------------------------------------------------------
    // 3. No data items on canvas — no warning (nothing to check against)
    // -----------------------------------------------------------------------

    describe("no canvas data items", () => {

        it("does not warn about refs when canvas has no data items at all", () => {
            const file = new DiagramModelFile(factory);
            const canvas = file.canvas;
            const procA = factory.createNewDiagramObject("process", Block);
            const procB = factory.createNewDiagramObject("process", Block);
            canvas.addObject(procA);
            canvas.addObject(procB);

            const flow = factory.createNewDiagramObject("data_flow", Line);
            canvas.addObject(flow);
            connect(flow, procA, procB);

            // No data items on canvas; add a ref that would normally be dangling
            addDataItemRef(flow, "some-guid");

            setName(procA, "ProcA");
            setName(procB, "ProcB");
            setName(flow, "Flow1");

            validator.run(file);

            const danglingWarnings = validator.getWarnings().filter(
                w => w.reason.includes("unknown data item")
            );
            // When knownGuids is empty, the validator skips the check entirely
            expect(danglingWarnings).toHaveLength(0);
        });

    });

    // -----------------------------------------------------------------------
    // 4. Mixed valid and dangling refs
    // -----------------------------------------------------------------------

    describe("mixed valid and dangling refs", () => {

        it("warns only for the dangling ref; valid ref produces no warning", () => {
            const file = new DiagramModelFile(factory);
            const canvas = file.canvas;
            const procA = factory.createNewDiagramObject("process", Block);
            const procB = factory.createNewDiagramObject("process", Block);
            canvas.addObject(procA);
            canvas.addObject(procB);

            const flow = factory.createNewDiagramObject("data_flow", Line);
            canvas.addObject(flow);
            connect(flow, procA, procB);

            addDataItem(canvas, "valid-guid", procA.instance, "D1", "Valid");
            addDataItemRef(flow, "valid-guid");
            addDataItemRef(flow, "dangling-guid");

            setName(procA, "ProcA");
            setName(procB, "ProcB");
            setName(flow, "Flow1");

            validator.run(file);

            const danglingWarnings = validator.getWarnings().filter(
                w => w.reason.includes("unknown data item")
            );
            expect(danglingWarnings).toHaveLength(1);
            expect(danglingWarnings[0].reason).toContain("dangling-guid");
        });

    });

});
