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
    line.node1.link(srcAnchor);
    line.node2.link(trgAnchor);
}

/** Sets the required `name` string property on a diagram object. */
function setName(obj: DiagramObject, name: string): void {
    (obj.properties.value.get("name") as StringProperty).setValue(name);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DfdValidator — data_item_refs dangling-ref warning (AC5.2, AC5.3)", () => {

    let factory: DiagramObjectFactory;
    let validator: DfdValidator;

    beforeEach(() => {
        factory = new DiagramObjectFactory(dfdSchema);
        validator = new DfdValidator();
    });

    // -----------------------------------------------------------------------
    // 1. Valid ref — no warning
    // -----------------------------------------------------------------------

    describe("valid refs", () => {

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

            // Add a valid data item and reference it from the flow in node1 direction
            addDataItem(canvas, "item-1", procA.instance, "D1", "My Item", undefined, "pii");
            addDataItemRef(flow, "item-1", "node1");

            // Set required fields to avoid unrelated errors
            setName(procA, "ProcA");
            setName(procB, "ProcB");
            setName(flow, "Flow1");

            validator.run(file);

            const warnings = validator.getWarnings();
            const danglingWarnings = warnings.filter(w => w.reason.includes("unknown data item"));
            expect(danglingWarnings).toHaveLength(0);
        });

        it("does not warn when both directions are populated and valid", () => {
            const file = new DiagramModelFile(factory);
            const canvas = file.canvas;
            const procA = factory.createNewDiagramObject("process", Block);
            const procB = factory.createNewDiagramObject("process", Block);
            canvas.addObject(procA);
            canvas.addObject(procB);

            const flow = factory.createNewDiagramObject("data_flow", Line);
            canvas.addObject(flow);
            connect(flow, procA, procB);

            // Add two data items and reference them in opposite directions
            addDataItem(canvas, "item-a", procA.instance, "D1", "Item A");
            addDataItem(canvas, "item-b", procB.instance, "D2", "Item B");
            addDataItemRef(flow, "item-a", "node1");
            addDataItemRef(flow, "item-b", "node2");

            setName(procA, "ProcA");
            setName(procB, "ProcB");
            setName(flow, "Flow1");

            validator.run(file);

            const danglingWarnings = validator.getWarnings().filter(
                w => w.reason.includes("unknown data item")
            );
            expect(danglingWarnings).toHaveLength(0);
        });

    });

    // -----------------------------------------------------------------------
    // 2. Dangling ref — warning emitted per-direction
    // -----------------------------------------------------------------------

    describe("dangling refs — per-direction warnings (AC5.2)", () => {

        it("emits a warning (not an error) for a ref in node1 direction that doesn't match any data item", () => {
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
            // Add a DANGLING ref in node1 direction (not in canvas data_items)
            addDataItemRef(flow, "dangling-guid-xyz", "node1");

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
            expect(danglingWarnings[0].reason).toContain("node1_src_data_item_refs");

            // Must not have been added to errors
            const danglingErrors = errors.filter(e => e.reason.includes("unknown data item"));
            expect(danglingErrors).toHaveLength(0);
        });

        it("includes direction key name for node2 direction dangling ref", () => {
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
            // Dangling ref in node2 direction
            addDataItemRef(flow, "dangling-xyz", "node2");

            setName(procA, "ProcA");
            setName(procB, "ProcB");
            setName(flow, "Flow1");

            validator.run(file);

            const danglingWarnings = validator.getWarnings().filter(
                w => w.reason.includes("unknown data item")
            );
            expect(danglingWarnings).toHaveLength(1);
            expect(danglingWarnings[0].reason).toContain("node2_src_data_item_refs");
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
            addDataItemRef(flow, "dangling-guid-xyz", "node1");

            setName(procA, "ProcA");
            setName(procB, "ProcB");
            setName(flow, "Flow1");

            validator.run(file);

            // Dangling ref must not produce an error that blocks save/publish
            expect(validator.inValidState()).toBe(true);
        });

        it("emits one warning per dangling ref (multiple dangling refs in different directions)", () => {
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
            // Two dangling refs in opposite directions
            addDataItemRef(flow, "dangling-a", "node1");
            addDataItemRef(flow, "dangling-b", "node2");

            setName(procA, "ProcA");
            setName(procB, "ProcB");
            setName(flow, "Flow1");

            validator.run(file);

            const danglingWarnings = validator.getWarnings().filter(
                w => w.reason.includes("unknown data item")
            );
            expect(danglingWarnings).toHaveLength(2);
            const node1Warnings = danglingWarnings.filter(w => w.reason.includes("node1_src"));
            const node2Warnings = danglingWarnings.filter(w => w.reason.includes("node2_src"));
            expect(node1Warnings).toHaveLength(1);
            expect(node2Warnings).toHaveLength(1);
        });

        it("does not warn when both ref arrays are empty (AC5.3)", () => {
            const file = new DiagramModelFile(factory);
            const canvas = file.canvas;
            const procA = factory.createNewDiagramObject("process", Block);
            const procB = factory.createNewDiagramObject("process", Block);
            canvas.addObject(procA);
            canvas.addObject(procB);

            const flow = factory.createNewDiagramObject("data_flow", Line);
            canvas.addObject(flow);
            connect(flow, procA, procB);

            // No data items on canvas; no refs on flow (both directions empty)
            setName(procA, "ProcA");
            setName(procB, "ProcB");
            setName(flow, "Flow1");

            validator.run(file);

            const danglingWarnings = validator.getWarnings().filter(
                w => w.reason.includes("unknown data item")
            );
            expect(danglingWarnings).toHaveLength(0);
        });

    });

    // -----------------------------------------------------------------------
    // 3. No data items on canvas — dangling refs still warn
    // -----------------------------------------------------------------------

    describe("no canvas data items", () => {

        it("warns about refs even when canvas has no data items at all", () => {
            // Previously, the validator skipped the ref check when knownGuids was
            // empty.  That masked the strongest dangling-ref case: a flow that holds
            // refs to data items that were subsequently deleted (leaving the canvas
            // with zero items).  The early-return was removed (M8).
            const file = new DiagramModelFile(factory);
            const canvas = file.canvas;
            const procA = factory.createNewDiagramObject("process", Block);
            const procB = factory.createNewDiagramObject("process", Block);
            canvas.addObject(procA);
            canvas.addObject(procB);

            const flow = factory.createNewDiagramObject("data_flow", Line);
            canvas.addObject(flow);
            connect(flow, procA, procB);

            // No data items on canvas; add a ref that is dangling by definition
            addDataItemRef(flow, "some-guid");

            setName(procA, "ProcA");
            setName(procB, "ProcB");
            setName(flow, "Flow1");

            validator.run(file);

            const danglingWarnings = validator.getWarnings().filter(
                w => w.reason.includes("unknown data item")
            );
            // Now warns even when knownGuids is empty — dangling ref is dangling.
            expect(danglingWarnings).toHaveLength(1);
            expect(danglingWarnings[0].reason).toContain("some-guid");
        });

        it("does not warn when the flow has no refs (zero-ref flow on empty canvas)", () => {
            const file = new DiagramModelFile(factory);
            const canvas = file.canvas;
            const procA = factory.createNewDiagramObject("process", Block);
            const procB = factory.createNewDiagramObject("process", Block);
            canvas.addObject(procA);
            canvas.addObject(procB);

            const flow = factory.createNewDiagramObject("data_flow", Line);
            canvas.addObject(flow);
            connect(flow, procA, procB);
            // No data items on canvas; no refs on the flow
            setName(procA, "ProcA");
            setName(procB, "ProcB");
            setName(flow, "Flow1");

            validator.run(file);

            const danglingWarnings = validator.getWarnings().filter(
                w => w.reason.includes("unknown data item")
            );
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

// ---------------------------------------------------------------------------
// Tests: DfdValidator — data item missing required fields (I2)
// ---------------------------------------------------------------------------

describe("DfdValidator — data item missing required fields (I2)", () => {

    let factory: DiagramObjectFactory;
    let validator: DfdValidator;

    beforeEach(() => {
        factory = new DiagramObjectFactory(dfdSchema);
        validator = new DfdValidator();
    });

    it("does not warn when all data items have all required fields", () => {
        const file = new DiagramModelFile(factory);
        const canvas = file.canvas;
        const procA = factory.createNewDiagramObject("process", Block);
        canvas.addObject(procA);
        setName(procA, "ProcA");

        addDataItem(canvas, "item-1", procA.instance, "D1", "Full Item");

        validator.run(file);

        const missingWarnings = validator.getWarnings().filter(
            w => w.reason.includes("missing required field")
        );
        expect(missingWarnings).toHaveLength(0);
    });

    it("emits a warning for a data item missing its identifier", () => {
        const file = new DiagramModelFile(factory);
        const canvas = file.canvas;
        const procA = factory.createNewDiagramObject("process", Block);
        canvas.addObject(procA);
        setName(procA, "ProcA");

        // Add item via addDataItem with empty identifier (simulates missing field)
        addDataItem(canvas, "item-missing-id", procA.instance, "", "Name Without ID");

        validator.run(file);

        const missingWarnings = validator.getWarnings().filter(
            w => w.reason.includes("missing required field")
        );
        expect(missingWarnings).toHaveLength(1);
        expect(missingWarnings[0].reason).toContain("identifier");
    });

    it("warning does not block validation — inValidState() is true", () => {
        const file = new DiagramModelFile(factory);
        const canvas = file.canvas;
        const procA = factory.createNewDiagramObject("process", Block);
        canvas.addObject(procA);
        setName(procA, "ProcA");

        addDataItem(canvas, "item-partial", procA.instance, "", "");

        validator.run(file);

        expect(validator.inValidState()).toBe(true);
    });

    it("lists all missing fields in a single warning when multiple are absent", () => {
        const file = new DiagramModelFile(factory);
        const canvas = file.canvas;
        const procA = factory.createNewDiagramObject("process", Block);
        canvas.addObject(procA);
        setName(procA, "ProcA");

        // Item with both identifier and name empty
        addDataItem(canvas, "item-empty", procA.instance, "", "");

        validator.run(file);

        const missingWarnings = validator.getWarnings().filter(
            w => w.reason.includes("missing required field")
        );
        expect(missingWarnings).toHaveLength(1);
        expect(missingWarnings[0].reason).toContain("identifier");
        expect(missingWarnings[0].reason).toContain("name");
    });

});
