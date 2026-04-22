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
import { SetStringProperty } from "@OpenChart/DiagramEditor/Commands/Property/index.commands";

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
 * Typed as `unknown` externally; tests access via typed property casts.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeMockEditor(canvas: any): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listeners: Array<(...args: any[]) => void> = [];
    return {
        file: { canvas },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        on(_event: string, handler: (...args: any[]) => void) {
            listeners.push(handler);
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        removeEventListener(_event: string, handler: (...args: any[]) => void) {
            const idx = listeners.indexOf(handler);
            if (idx !== -1) { listeners.splice(idx, 1); }
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        emit(_event: string, ...args: any[]) {
            for (const fn of listeners) { fn(...args); }
        },
        listenerCount() { return listeners.length; }
    };
}

function mountSection(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    canvas: any,
    blockGuid: string = BLOCK_GUID
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
): { wrapper: ReturnType<typeof mount>, store: ReturnType<typeof useApplicationStore>, mockEditor: any } {
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn });
    const store = useApplicationStore();
    const mockEditor = makeMockEditor(canvas);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (wrapper.vm as any).onUnown("guid-1");
            await wrapper.vm.$nextTick();

            expect(wrapper.emitted("execute")).toBeTruthy();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const cmd = wrapper.emitted("execute")![0][0] as any;
            expect(cmd.constructor.name).toBe("SetStringProperty");
            expect(cmd.nextValue).toBeNull();
        });

        it("onUnown with unknown guid does not emit", async () => {
            const canvas = makeCanvas([["guid-1", BLOCK_GUID, "D1", "Item"]]);
            const { wrapper } = mountSection(canvas);
            await wrapper.vm.$nextTick();

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

        it("clicking × on a chip emits the correct command via template binding", async () => {
            const canvas = makeCanvas([["guid-1", BLOCK_GUID, "D1", "Card Number"]]);
            const { wrapper } = mountSection(canvas);
            await wrapper.vm.$nextTick();

            // Trigger via the real DOM element to exercise the @click template binding
            wrapper.find(".delete-button").element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await wrapper.vm.$nextTick();

            const emitted = wrapper.emitted("execute");
            expect(emitted).toHaveLength(1);
            expect(emitted![0][0]).toBeInstanceOf(SetStringProperty);
            expect((emitted![0][0] as SetStringProperty).nextValue).toBeNull();
        });
    });

    describe("adopt action (dropdown selection)", () => {
        it("selecting an unowned item emits setStringProperty with blockGuid", async () => {
            const canvas = makeCanvas([["guid-1", "", "D1", "Unowned Item"]]);
            const { wrapper } = mountSection(canvas);
            await wrapper.vm.$nextTick();

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (wrapper.vm as any).onAdopt("guid-1");
            await wrapper.vm.$nextTick();

            expect(wrapper.emitted("execute")).toBeTruthy();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const cmd = wrapper.emitted("execute")![0][0] as any;
            expect(cmd.constructor.name).toBe("SetStringProperty");
            expect(cmd.nextValue).toBe(BLOCK_GUID);
        });

        it("adopt only emits one command (not two) for a single selection", async () => {
            const canvas = makeCanvas([["guid-1", "", "D1", "Unowned"]]);
            const { wrapper } = mountSection(canvas);
            await wrapper.vm.$nextTick();

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (wrapper.vm as any).onAdopt("guid-1");

            expect(wrapper.emitted("execute")).toHaveLength(1);
        });

        it("onAdopt with empty guid does not emit", async () => {
            const canvas = makeCanvas([["guid-1", "", "D1", "Unowned"]]);
            const { wrapper } = mountSection(canvas);
            await wrapper.vm.$nextTick();

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (wrapper.vm as any).onAdopt("");
            expect(wrapper.emitted("execute")).toBeFalsy();
        });

        it("selecting an unowned item via the dropdown emits the correct adopt command", async () => {
            const canvas = makeCanvas([["guid-1", "", "D1", "Unowned Item"]]);
            const { wrapper } = mountSection(canvas);
            await wrapper.vm.$nextTick();

            // Set the select value and dispatch a change event to exercise @change template binding
            const selectEl = wrapper.find(".data-item-dropdown").element as HTMLSelectElement;
            selectEl.value = "guid-1";
            selectEl.dispatchEvent(new Event("change", { bubbles: true }));
            await wrapper.vm.$nextTick();

            const emitted = wrapper.emitted("execute");
            expect(emitted).toHaveLength(1);
            expect(emitted![0][0]).toBeInstanceOf(SetStringProperty);
            expect((emitted![0][0] as SetStringProperty).nextValue).toBe(BLOCK_GUID);
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

    describe("editor swap listener lifecycle (M2)", () => {
        it("swapping editors removes listener from old editor and attaches to new one", async () => {
            const canvas = makeCanvas([]);
            const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn });
            const store = useApplicationStore();

            const editorA = makeMockEditor(canvas);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (store as any).activeEditor = editorA;

            const wrapper = mount(OwnedDataItemsSection, {
                props: { blockGuid: BLOCK_GUID },
                global: { plugins: [pinia] }
            });
            await wrapper.vm.$nextTick();

            // editorA should have one listener registered
            expect(editorA.listenerCount()).toBe(1);

            // Swap to editorB
            const editorB = makeMockEditor(canvas);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (store as any).activeEditor = editorB;
            await wrapper.vm.$nextTick();

            // The watcher fires: old listener removed from A, new one on B
            expect(editorA.listenerCount()).toBe(0);
            expect(editorB.listenerCount()).toBe(1);

            // Emitting on A is now a no-op — counter stays put
            const counterBefore = (wrapper.vm as { updateCounter: number }).updateCounter;
            editorA.emit("edit");
            await wrapper.vm.$nextTick();
            expect((wrapper.vm as { updateCounter: number }).updateCounter).toBe(counterBefore);

            // Emitting on B increments the counter
            editorB.emit("edit");
            await wrapper.vm.$nextTick();
            expect((wrapper.vm as { updateCounter: number }).updateCounter).toBe(counterBefore + 1);
        });
    });

});
