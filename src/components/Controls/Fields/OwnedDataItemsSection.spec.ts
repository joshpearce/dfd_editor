// @vitest-environment jsdom
// pattern: Functional Core

import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createTestingPinia } from "@pinia/testing";
import OwnedDataItemsSection from "./OwnedDataItemsSection.vue";
import {
    ListProperty, DictionaryProperty, StringProperty,
    DataItemParentRefProperty, RootProperty
} from "@OpenChart/DiagramModel";
import { useApplicationStore } from "@/stores/ApplicationStore";

/* eslint-disable @typescript-eslint/no-explicit-any */

///////////////////////////////////////////////////////////////////////////////
//  1. Test Helpers  ///////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

const BLOCK_GUID = "block-guid-1234";

/**
 * Build a DictionaryProperty with data-item sub-properties and a
 * DataItemParentRefProperty for `parent`.
 */
function makeDataItemDict(parent: string, identifier: string, name: string): DictionaryProperty {
    const dict = new DictionaryProperty({ id: "item", name: "item", editable: true });

    const parentProp = new DataItemParentRefProperty({ id: "parent", name: "Parent", editable: true });
    parentProp.setValue(parent);
    dict.addProperty(parentProp, "parent");

    const identProp = new StringProperty({ id: "identifier", name: "Identifier", editable: true });
    identProp.setValue(identifier);
    dict.addProperty(identProp, "identifier");

    const nameProp = new StringProperty({ id: "name", name: "Name", editable: true });
    nameProp.setValue(name);
    dict.addProperty(nameProp, "name");

    return dict;
}

/**
 * Build a canvas with a data_items ListProperty.
 * Items is an array of [guid, parent, identifier, name].
 */
function makeCanvas(items: Array<[string, string, string, string]> = []): any {
    const rootProps = new RootProperty();

    const listProp = new ListProperty({
        id: "data_items",
        name: "data_items",
        editable: true,
        template: new DictionaryProperty({ id: "item", name: "item", editable: true })
    });

    for (const [guid, parent, identifier, name] of items) {
        const dict = makeDataItemDict(parent, identifier, name);
        listProp.addProperty(dict, guid);
    }

    rootProps.addProperty(listProp, "data_items");
    return { properties: rootProps };
}

/**
 * Build a minimal mock editor supporting .on() / .removeEventListener() and
 * emit() for test-driven "edit" events.
 */
function makeMockEditor(canvas: any): any {
    const listeners: Array<(...args: any[]) => void> = [];
    return {
        file: { canvas },
        on(_event: string, handler: (...args: any[]) => void) {
            listeners.push(handler);
        },
        removeEventListener(_event: string, handler: (...args: any[]) => void) {
            const idx = listeners.indexOf(handler);
            if (idx !== -1) { listeners.splice(idx, 1); }
        },
        emit(_event: string, ...args: any[]) {
            for (const fn of listeners) { fn(...args); }
        }
    };
}

function mountSection(
    canvas: any,
    blockGuid: string = BLOCK_GUID
): { wrapper: ReturnType<typeof mount>, store: ReturnType<typeof useApplicationStore>, mockEditor: any } {
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn });
    const store = useApplicationStore();
    const mockEditor = makeMockEditor(canvas);
    (store as any).activeEditor = mockEditor;
    const wrapper = mount(OwnedDataItemsSection, {
        props: { blockGuid },
        global: { plugins: [pinia] }
    });
    return { wrapper, store, mockEditor };
}

///////////////////////////////////////////////////////////////////////////////
//  2. Tests  //////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

describe("OwnedDataItemsSection", () => {

    describe("empty state", () => {
        it("shows empty-state message when no data items exist", async () => {
            const canvas = makeCanvas([]);
            const { wrapper } = mountSection(canvas);
            await wrapper.vm.$nextTick();

            expect(wrapper.find(".empty-state").exists()).toBe(true);
            expect(wrapper.find(".empty-state").text()).toContain("No data items owned");
        });

        it("does not render chip list when no items exist", async () => {
            const canvas = makeCanvas([]);
            const { wrapper } = mountSection(canvas);
            await wrapper.vm.$nextTick();

            expect(wrapper.find(".owned-list").exists()).toBe(false);
        });

        it("does not render dropdown when no unowned items exist", async () => {
            const canvas = makeCanvas([["guid-1", BLOCK_GUID, "D1", "Credit Card"]]);
            const { wrapper } = mountSection(canvas);
            await wrapper.vm.$nextTick();

            expect(wrapper.find(".data-item-dropdown").exists()).toBe(false);
        });
    });

    describe("chip list for owned items", () => {
        it("renders a chip for each item owned by this block", async () => {
            const canvas = makeCanvas([
                ["guid-1", BLOCK_GUID, "D1", "Card Number"],
                ["guid-2", BLOCK_GUID, "D2", "SSN"]
            ]);
            const { wrapper } = mountSection(canvas);
            await wrapper.vm.$nextTick();

            const chips = wrapper.findAll(".owned-chip");
            expect(chips).toHaveLength(2);
            expect(chips[0].text()).toContain("Card Number");
            expect(chips[1].text()).toContain("SSN");
        });

        it("does not render chips for items owned by other blocks", async () => {
            const canvas = makeCanvas([
                ["guid-1", "other-block-guid", "D1", "Other Block Item"],
                ["guid-2", BLOCK_GUID, "D2", "My Item"]
            ]);
            const { wrapper } = mountSection(canvas);
            await wrapper.vm.$nextTick();

            const chips = wrapper.findAll(".owned-chip");
            expect(chips).toHaveLength(1);
            expect(chips[0].text()).toContain("My Item");
        });

        it("does not show empty-state when owned items exist", async () => {
            const canvas = makeCanvas([["guid-1", BLOCK_GUID, "D1", "Item"]]);
            const { wrapper } = mountSection(canvas);
            await wrapper.vm.$nextTick();

            expect(wrapper.find(".empty-state").exists()).toBe(false);
        });
    });

    describe("unowned items dropdown", () => {
        it("shows dropdown with unowned items", async () => {
            const canvas = makeCanvas([
                ["guid-1", BLOCK_GUID, "D1", "Owned Item"],
                ["guid-2", "", "D2", "Unowned Item"]
            ]);
            const { wrapper } = mountSection(canvas);
            await wrapper.vm.$nextTick();

            const dropdown = wrapper.find(".data-item-dropdown");
            expect(dropdown.exists()).toBe(true);

            const options = wrapper.findAll(".data-item-dropdown option");
            const values = options.map(o => (o.element as HTMLOptionElement).value);
            expect(values).toContain("guid-2");
            expect(values).not.toContain("guid-1");
        });

        it("does not show dropdown when all items are owned", async () => {
            const canvas = makeCanvas([
                ["guid-1", BLOCK_GUID, "D1", "Mine"]
            ]);
            const { wrapper } = mountSection(canvas);
            await wrapper.vm.$nextTick();

            expect(wrapper.find(".data-item-dropdown").exists()).toBe(false);
        });

        it("shows placeholder option as first in dropdown", async () => {
            const canvas = makeCanvas([["guid-1", "", "D1", "Unowned"]]);
            const { wrapper } = mountSection(canvas);
            await wrapper.vm.$nextTick();

            const options = wrapper.findAll(".data-item-dropdown option");
            expect((options[0].element as HTMLOptionElement).value).toBe("");
            expect(options[0].text()).toContain("Add unowned data item");
        });
    });

    describe("unown action (× button)", () => {
        it("onUnown emits setStringProperty with null", async () => {
            const canvas = makeCanvas([["guid-1", BLOCK_GUID, "D1", "Card Number"]]);
            const { wrapper } = mountSection(canvas);
            await wrapper.vm.$nextTick();

            (wrapper.vm as any).onUnown("guid-1");
            await wrapper.vm.$nextTick();

            expect(wrapper.emitted("execute")).toBeTruthy();
            const cmd = wrapper.emitted("execute")![0][0] as any;
            expect(cmd.constructor.name).toBe("SetStringProperty");
            expect(cmd.nextValue).toBeNull();
        });

        it("onUnown with unknown guid does not emit", async () => {
            const canvas = makeCanvas([["guid-1", BLOCK_GUID, "D1", "Item"]]);
            const { wrapper } = mountSection(canvas);
            await wrapper.vm.$nextTick();

            (wrapper.vm as any).onUnown("not-a-real-guid");
            expect(wrapper.emitted("execute")).toBeFalsy();
        });

        it("unown chip renders one × button per owned item", async () => {
            const canvas = makeCanvas([
                ["guid-1", BLOCK_GUID, "D1", "Item One"],
                ["guid-2", BLOCK_GUID, "D2", "Item Two"]
            ]);
            const { wrapper } = mountSection(canvas);
            await wrapper.vm.$nextTick();

            const deleteButtons = wrapper.findAll(".delete-button");
            expect(deleteButtons).toHaveLength(2);
        });
    });

    describe("adopt action (dropdown selection)", () => {
        it("selecting an unowned item emits setStringProperty with blockGuid", async () => {
            const canvas = makeCanvas([["guid-1", "", "D1", "Unowned Item"]]);
            const { wrapper } = mountSection(canvas);
            await wrapper.vm.$nextTick();

            (wrapper.vm as any).onAdopt("guid-1");
            await wrapper.vm.$nextTick();

            expect(wrapper.emitted("execute")).toBeTruthy();
            const cmd = wrapper.emitted("execute")![0][0] as any;
            expect(cmd.constructor.name).toBe("SetStringProperty");
            expect(cmd.nextValue).toBe(BLOCK_GUID);
        });

        it("adopt only emits one command (not two) for a single selection", async () => {
            const canvas = makeCanvas([["guid-1", "", "D1", "Unowned"]]);
            const { wrapper } = mountSection(canvas);
            await wrapper.vm.$nextTick();

            (wrapper.vm as any).onAdopt("guid-1");

            expect(wrapper.emitted("execute")).toHaveLength(1);
        });

        it("onAdopt with empty guid does not emit", async () => {
            const canvas = makeCanvas([["guid-1", "", "D1", "Unowned"]]);
            const { wrapper } = mountSection(canvas);
            await wrapper.vm.$nextTick();

            (wrapper.vm as any).onAdopt("");
            expect(wrapper.emitted("execute")).toBeFalsy();
        });
    });

    describe("reactivity via editor 'edit' events", () => {
        it("after 'edit' event, newly unowned items appear in dropdown", async () => {
            const canvas = makeCanvas([["guid-1", BLOCK_GUID, "D1", "Was Owned"]]);
            const { wrapper, mockEditor } = mountSection(canvas);
            await wrapper.vm.$nextTick();

            // Initially no dropdown (item is owned)
            expect(wrapper.find(".data-item-dropdown").exists()).toBe(false);

            // Mutate canvas: set parent to empty (simulating unown)
            const listProp = canvas.properties.value.get("data_items") as ListProperty;
            const dict = listProp.value.get("guid-1") as DictionaryProperty;
            const parentProp = dict.value.get("parent") as DataItemParentRefProperty;
            parentProp.setValue("");

            mockEditor.emit("edit");
            await wrapper.vm.$nextTick();

            expect(wrapper.find(".data-item-dropdown").exists()).toBe(true);
            const options = wrapper.findAll(".data-item-dropdown option");
            const values = options.map(o => (o.element as HTMLOptionElement).value);
            expect(values).toContain("guid-1");
        });

        it("after 'edit' event, adopted item moves from dropdown to chip list", async () => {
            const canvas = makeCanvas([["guid-1", "", "D1", "Unowned"]]);
            const { wrapper, mockEditor } = mountSection(canvas);
            await wrapper.vm.$nextTick();

            // Initially unowned: dropdown visible, chip not
            expect(wrapper.find(".data-item-dropdown").exists()).toBe(true);
            expect(wrapper.findAll(".owned-chip")).toHaveLength(0);

            // Mutate canvas: adopt the item
            const listProp = canvas.properties.value.get("data_items") as ListProperty;
            const dict = listProp.value.get("guid-1") as DictionaryProperty;
            const parentProp = dict.value.get("parent") as DataItemParentRefProperty;
            parentProp.setValue(BLOCK_GUID);

            mockEditor.emit("edit");
            await wrapper.vm.$nextTick();

            expect(wrapper.findAll(".owned-chip")).toHaveLength(1);
            expect(wrapper.find(".data-item-dropdown").exists()).toBe(false);
        });

        it("after 'edit' event, new data item added to canvas appears in dropdown", async () => {
            const canvas = makeCanvas([]);
            const { wrapper, mockEditor } = mountSection(canvas);
            await wrapper.vm.$nextTick();

            expect(wrapper.find(".data-item-dropdown").exists()).toBe(false);

            // Add new unowned item to canvas
            const listProp = canvas.properties.value.get("data_items") as ListProperty;
            const newDict = makeDataItemDict("", "D2", "New Item");
            listProp.addProperty(newDict, "guid-new");

            mockEditor.emit("edit");
            await wrapper.vm.$nextTick();

            expect(wrapper.find(".data-item-dropdown").exists()).toBe(true);
            const values = wrapper.findAll(".data-item-dropdown option")
                .map(o => (o.element as HTMLOptionElement).value);
            expect(values).toContain("guid-new");
        });
    });

});
