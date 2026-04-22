// @vitest-environment jsdom
// pattern: Functional Core

import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createTestingPinia } from "@pinia/testing";
import DataItemParentRefField from "./DataItemParentRefField.vue";
import { DataItemParentRefProperty, StringProperty, RootProperty } from "@OpenChart/DiagramModel";
import { useApplicationStore } from "@/stores/ApplicationStore";

/* eslint-disable @typescript-eslint/no-explicit-any */

///////////////////////////////////////////////////////////////////////////////
//  1. Test Helpers  ///////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

function makeBlock(templateId: string, name: string, instance: string): any {
    const props = new RootProperty();
    const nameProp = new StringProperty({ id: "name", name: "name", editable: true });
    nameProp.setValue(name);
    props.addProperty(nameProp, "name");
    return { id: templateId, instance, properties: props, blocks: [], groups: [] };
}

function makeCanvas(directBlocks: any[] = [], groups: any[] = []): any {
    const props = new RootProperty();
    return { properties: props, blocks: directBlocks, groups };
}

function makeMockFile(canvas: any): any {
    return { canvas };
}

function makeProperty(value: string | null = null): DataItemParentRefProperty {
    const prop = new DataItemParentRefProperty({ id: "parent", name: "Parent", editable: true });
    if (value !== null) {
        prop.setValue(value);
    }
    return prop;
}

/**
 * Mount the component with the given store canvas pre-configured.
 * Setting the file before mounting ensures the immediate watch fires
 * with the correct canvas and subscriptions target the test blocks.
 */
function mountWithCanvas(
    property: DataItemParentRefProperty,
    canvas: any
): { wrapper: ReturnType<typeof mount>, store: ReturnType<typeof useApplicationStore> } {
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn });
    const store = useApplicationStore();
    (store.activeEditor as any).file = makeMockFile(canvas);
    const wrapper = mount(DataItemParentRefField, {
        props: { property },
        global: { plugins: [pinia] }
    });
    return { wrapper, store };
}

///////////////////////////////////////////////////////////////////////////////
//  2. Tests  //////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

describe("DataItemParentRefField", () => {

    it("options include (unowned) and only eligible template blocks", async () => {
        const process = makeBlock("process", "My Process", "guid-process");
        const dataStore = makeBlock("data_store", "My Store", "guid-store");
        const external = makeBlock("external_entity", "External", "guid-ext");
        const dataFlow = makeBlock("data_flow", "Flow", "guid-flow");
        const trustBoundary = makeBlock("trust_boundary", "Zone", "guid-zone");
        const canvas = makeCanvas([process, dataStore, external, dataFlow, trustBoundary]);

        const { wrapper } = mountWithCanvas(makeProperty(), canvas);
        await wrapper.vm.$nextTick();

        const options = wrapper.findAll("option");
        const values = options.map(o => (o.element as HTMLOptionElement).value);

        expect(values).toContain("");
        expect(values).toContain("guid-process");
        expect(values).toContain("guid-store");
        expect(values).toContain("guid-ext");
        expect(values).not.toContain("guid-flow");
        expect(values).not.toContain("guid-zone");

        const texts = options.map(o => (o.element as HTMLOptionElement).text);
        const unownedText = texts[values.indexOf("")];
        expect(unownedText).toBe("(unowned)");
    });

    it("excludes blocks with non-eligible templates (container, data_flow)", async () => {
        const container = makeBlock("container", "Box", "guid-container");
        const flow = makeBlock("data_flow", "Flow", "guid-flow");
        const canvas = makeCanvas([container, flow]);

        const { wrapper } = mountWithCanvas(makeProperty(), canvas);
        await wrapper.vm.$nextTick();

        const options = wrapper.findAll("option");
        expect(options.length).toBe(1); // only (unowned)
    });

    it("includes eligible blocks nested inside groups", async () => {
        const nestedProcess = makeBlock("process", "Nested Process", "guid-nested");
        const group = {
            id: "trust_boundary", instance: "guid-tb",
            blocks: [nestedProcess], groups: []
        };
        const canvas = makeCanvas([], [group]);

        const { wrapper } = mountWithCanvas(makeProperty(), canvas);
        await wrapper.vm.$nextTick();

        const values = wrapper.findAll("option").map(o => (o.element as HTMLOptionElement).value);
        expect(values).toContain("guid-nested");
    });

    it("selecting a block GUID emits setStringProperty with that GUID", async () => {
        const process = makeBlock("process", "Proc", "guid-p1");
        const canvas = makeCanvas([process]);

        const { wrapper } = mountWithCanvas(makeProperty(), canvas);
        await wrapper.vm.$nextTick();

        (wrapper.vm as any).onChange("guid-p1");
        await wrapper.vm.$nextTick();

        expect(wrapper.emitted("execute")).toBeTruthy();
        const cmd = wrapper.emitted("execute")![0][0] as any;
        expect(cmd.constructor.name).toBe("SetStringProperty");
        expect(cmd.nextValue).toBe("guid-p1");
    });

    it("selecting (unowned) emits setStringProperty with null", async () => {
        const process = makeBlock("process", "Proc", "guid-p1");
        const canvas = makeCanvas([process]);
        const prop = makeProperty("guid-p1");

        const { wrapper } = mountWithCanvas(prop, canvas);
        await wrapper.vm.$nextTick();

        (wrapper.vm as any).onChange("");
        await wrapper.vm.$nextTick();

        expect(wrapper.emitted("execute")).toBeTruthy();
        const cmd = wrapper.emitted("execute")![0][0] as any;
        expect(cmd.constructor.name).toBe("SetStringProperty");
        expect(cmd.nextValue).toBeNull();
    });

    it("renaming a block updates the option label via subscription", async () => {
        const process = makeBlock("process", "OldName", "guid-p");
        const canvas = makeCanvas([process]);

        const { wrapper } = mountWithCanvas(makeProperty(), canvas);
        await wrapper.vm.$nextTick();

        let option = wrapper.findAll("option").find(
            o => (o.element as HTMLOptionElement).value === "guid-p"
        );
        expect(option?.text()).toBe("OldName");

        // Rename: mutate block's name property; subscription handler fires
        const nameProp = process.properties.value.get("name") as StringProperty;
        nameProp.setValue("NewName");
        await wrapper.vm.$nextTick();

        option = wrapper.findAll("option").find(
            o => (o.element as HTMLOptionElement).value === "guid-p"
        );
        expect(option?.text()).toBe("NewName");
    });

    it("adding a block to canvas and triggering canvas RootProperty fires re-render", async () => {
        const canvas = makeCanvas([]);

        const { wrapper } = mountWithCanvas(makeProperty(), canvas);
        await wrapper.vm.$nextTick();

        // Initially only (unowned)
        expect(wrapper.findAll("option").length).toBe(1);

        // Simulate block addition: push to the mutable array and fire canvas RP update
        const newBlock = makeBlock("process", "Added Process", "guid-added");
        canvas.blocks.push(newBlock);

        // Trigger canvas RootProperty subscribers by adding a property to it
        // (this simulates any canvas-level property update that would happen in real usage)
        const triggerProp = new StringProperty({ id: "trigger", name: "trigger", editable: true });
        (canvas.properties as RootProperty).addProperty(triggerProp, "trigger");
        await wrapper.vm.$nextTick();

        const values = wrapper.findAll("option").map(o => (o.element as HTMLOptionElement).value);
        expect(values).toContain("guid-added");
    });

    it("shows (unowned) option selected when property value is empty string", async () => {
        const canvas = makeCanvas([]);
        const prop = makeProperty("");

        const { wrapper } = mountWithCanvas(prop, canvas);
        await wrapper.vm.$nextTick();

        const select = wrapper.find("select");
        expect((select.element as HTMLSelectElement).value).toBe("");
    });

    it("shows (unowned) option when property value is null", async () => {
        const canvas = makeCanvas([]);
        const prop = makeProperty(null);

        const { wrapper } = mountWithCanvas(prop, canvas);
        await wrapper.vm.$nextTick();

        const values = wrapper.findAll("option").map(o => (o.element as HTMLOptionElement).value);
        expect(values[0]).toBe("");
    });

    it("shows block name as display label in dropdown", async () => {
        const process = makeBlock("process", "My Process Name", "guid-mp");
        const canvas = makeCanvas([process]);

        const { wrapper } = mountWithCanvas(makeProperty(), canvas);
        await wrapper.vm.$nextTick();

        const option = wrapper.findAll("option").find(
            o => (o.element as HTMLOptionElement).value === "guid-mp"
        );
        expect(option?.text()).toBe("My Process Name");
    });

    it("(unowned) appears first in options list", async () => {
        const process = makeBlock("process", "Proc", "guid-p");
        const canvas = makeCanvas([process]);

        const { wrapper } = mountWithCanvas(makeProperty(), canvas);
        await wrapper.vm.$nextTick();

        const options = wrapper.findAll("option");
        expect((options[0].element as HTMLOptionElement).value).toBe("");
        expect(options[0].text()).toBe("(unowned)");
    });

});
