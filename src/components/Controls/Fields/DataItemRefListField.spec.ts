// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createTestingPinia } from "@pinia/testing";
import DataItemRefListField from "./DataItemRefListField.vue";
import { DataItemRefListProperty, StringProperty, DictionaryProperty, ListProperty, RootProperty } from "@OpenChart/DiagramModel";
import { useApplicationStore } from "@/stores/ApplicationStore";
import type { BlockView, DiagramViewFile } from "@OpenChart/DiagramView";

/* eslint-disable @typescript-eslint/no-explicit-any */

///////////////////////////////////////////////////////////////////////////////
//  1. Mock/Test Helpers  /////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Creates a minimal mock BlockView with a name property using a real RootProperty.
 */
function createMockBlockView(name: string): Partial<BlockView> {
    const properties = new RootProperty();

    const nameProperty = new StringProperty({
        id: "name",
        name: "name",
        editable: true
    });
    nameProperty.setValue(name);

    properties.addProperty(nameProperty, "name");

    return {
        properties: properties
    } as any;
}

/**
 * Adds a data item to a mock canvas.
 */
function addMockDataItem(canvas: any, guid: string, identifier: string, name: string, classification?: string): void {
    // Ensure canvas has data_items property
    if (!canvas.properties.value.has("data_items")) {
        const dataItemsProperty = new ListProperty({
            id: "data_items",
            name: "data_items",
            editable: true,
            template: new DictionaryProperty({
                id: "template",
                name: "template",
                editable: true
            })
        });
        canvas.properties.value.set("data_items", dataItemsProperty);
    }

    const dataItemsProperty = canvas.properties.value.get("data_items") as ListProperty;

    // Create a DictionaryProperty for the data item
    const dataItem = new DictionaryProperty({
        id: guid,
        name: name,
        editable: true
    });

    // Add properties to the data item
    const parentProp = new StringProperty({
        id: "parent",
        name: "parent",
        editable: true
    });
    parentProp.setValue(canvas.id || "canvas");
    dataItem.addProperty(parentProp, "parent");

    const identifierProp = new StringProperty({
        id: "identifier",
        name: "identifier",
        editable: true
    });
    identifierProp.setValue(identifier);
    dataItem.addProperty(identifierProp, "identifier");

    const nameProp = new StringProperty({
        id: "name",
        name: "name",
        editable: true
    });
    nameProp.setValue(name);
    dataItem.addProperty(nameProp, "name");

    if (classification) {
        const classificationProp = new StringProperty({
            id: "classification",
            name: "classification",
            editable: true
        });
        classificationProp.setValue(classification);
        dataItem.addProperty(classificationProp, "classification");
    }

    dataItemsProperty.addProperty(dataItem, guid);
}

///////////////////////////////////////////////////////////////////////////////
//  2. Tests  /////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

describe("DataItemRefListField", () => {

    let mockFile: Partial<DiagramViewFile>;
    let mockRefListProperty: DataItemRefListProperty;
    let mockNode1View: Partial<BlockView>;
    let mockNode2View: Partial<BlockView>;

    beforeEach(() => {
        // Create a minimal mock file
        mockFile = {
            canvas: {
                id: "canvas-1",
                properties: {
                    value: new Map()
                }
            }
        } as unknown as Partial<DiagramViewFile>;

        // Add data items to canvas
        const canvas = mockFile.canvas as any;
        addMockDataItem(canvas, "di-1", "D1", "Data Item 1", "pii");
        addMockDataItem(canvas, "di-2", "D2", "Data Item 2", "secret");
        addMockDataItem(canvas, "di-3", "D3", "Data Item 3", "public");

        // Create mock block views
        mockNode1View = createMockBlockView("Source");
        mockNode2View = createMockBlockView("Target");

        // Create a DataItemRefListProperty
        mockRefListProperty = new DataItemRefListProperty({
            id: "test-ref-list",
            name: "Test Refs",
            editable: true,
            template: new StringProperty({
                id: "test-template",
                name: "Test Item",
                editable: true
            })
        });
    });

    it("AC4.1: renders a labelled section for the direction", async () => {
        // Set up store FIRST before mounting
        const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn });
        const wrapper = mount(DataItemRefListField, {
            props: {
                property: mockRefListProperty,
                context: {
                    node1View: mockNode1View as BlockView,
                    node2View: mockNode2View as BlockView,
                    direction: "node1ToNode2"
                }
            },
            global: {
                plugins: [pinia]
            }
        });

        // Set up store with test file
        const store = useApplicationStore();
        (store.activeEditor as any).file = mockFile;

        await wrapper.vm.$nextTick();

        // Assert: section contains label with non-empty text
        const label = wrapper.find(".direction-label");
        expect(label.exists()).toBe(true);
        expect(label.text().length).toBeGreaterThan(0);

        // Assert: dropdown is rendered (since we have data items available)
        const dropdown = wrapper.find(".data-item-dropdown");
        expect(dropdown.exists()).toBe(true);

        // Verify the section is rendered (not hidden due to missing context)
        const section = wrapper.find(".data-item-ref-list-field");
        expect(section.exists()).toBe(true);
    });

    it("AC4.2: label displays endpoint names (not node1/node2)", async () => {
        const wrapper = mount(DataItemRefListField, {
            props: {
                property: mockRefListProperty,
                context: {
                    node1View: mockNode1View as BlockView,
                    node2View: mockNode2View as BlockView,
                    direction: "node1ToNode2"
                }
            },
            global: {
                plugins: [createTestingPinia({ stubActions: false, createSpy: vi.fn })]
            }
        });

        const store = useApplicationStore();
        (store.activeEditor as any).file = mockFile;

        await wrapper.vm.$nextTick();

        // Assert label shows actual block names
        const label = wrapper.find(".direction-label").text();
        expect(label).toBe("Data from Source to Target");
    });

    it("AC4.3: selecting from dropdown emits addDataItemRef execute event", async () => {
        // Add one data item so we have a dropdown option
        const entry1 = mockRefListProperty.createListItem() as StringProperty;
        entry1.setValue("di-1");
        mockRefListProperty.addProperty(entry1);

        const wrapper = mount(DataItemRefListField, {
            props: {
                property: mockRefListProperty,
                context: {
                    node1View: mockNode1View as BlockView,
                    node2View: mockNode2View as BlockView,
                    direction: "node1ToNode2"
                }
            },
            global: {
                plugins: [createTestingPinia({ stubActions: false, createSpy: vi.fn })]
            }
        });

        const store = useApplicationStore();
        (store.activeEditor as any).file = mockFile;

        await wrapper.vm.$nextTick();

        // Call the onSelect method directly
        (wrapper.vm as any).onSelect("di-2");

        // Assert: execute event was emitted
        expect(wrapper.emitted("execute")).toBeTruthy();
        expect(wrapper.emitted("execute")!.length).toBeGreaterThan(0);

        const emittedCmd = wrapper.emitted("execute")![0][0] as any;
        expect(emittedCmd).toBeDefined();
        expect(emittedCmd.constructor.name).toBe("AddDataItemRef");
    });

    it("AC4.4: clicking delete on a chip emits deleteSubproperty with correct target id", async () => {
        // Add a data item
        const entry = mockRefListProperty.createListItem() as StringProperty;
        entry.setValue("di-1");
        mockRefListProperty.addProperty(entry);

        const wrapper = mount(DataItemRefListField, {
            props: {
                property: mockRefListProperty,
                context: {
                    node1View: mockNode1View as BlockView,
                    node2View: mockNode2View as BlockView,
                    direction: "node1ToNode2"
                }
            },
            global: {
                plugins: [createTestingPinia({ stubActions: false, createSpy: vi.fn })]
            }
        });

        const store = useApplicationStore();
        (store.activeEditor as any).file = mockFile;

        await wrapper.vm.$nextTick();

        // Get the actual key from the property value map (the synthetic key used by addProperty)
        const keys = Array.from(mockRefListProperty.value.keys());
        expect(keys.length).toBe(1);
        const entryKey = keys[0];

        // Call onDelete with the actual map key
        (wrapper.vm as any).onDelete(entryKey);

        // Assert: execute event was emitted with DeleteSubproperty
        expect(wrapper.emitted("execute")).toBeTruthy();
        const emittedCmd = wrapper.emitted("execute")![0][0] as any;
        expect(emittedCmd.constructor.name).toBe("DeleteSubproperty");

        // Verify the command targets the correct property.
        // The DeleteSubproperty constructor stores the property and subproperty it's targeting.
        // We verify by checking the property field matches ours (using deep equality).
        const deleteCmd = emittedCmd as { property: any };
        expect(deleteCmd.property).toStrictEqual(mockRefListProperty);
    });

    it("AC4.5: dropdown hides already-selected items", async () => {
        // Add two items
        const entry1 = mockRefListProperty.createListItem() as StringProperty;
        entry1.setValue("di-1");
        mockRefListProperty.addProperty(entry1);

        const entry2 = mockRefListProperty.createListItem() as StringProperty;
        entry2.setValue("di-2");
        mockRefListProperty.addProperty(entry2);

        const wrapper = mount(DataItemRefListField, {
            props: {
                property: mockRefListProperty,
                context: {
                    node1View: mockNode1View as BlockView,
                    node2View: mockNode2View as BlockView,
                    direction: "node1ToNode2"
                }
            },
            global: {
                plugins: [createTestingPinia({ stubActions: false, createSpy: vi.fn })]
            }
        });

        const store = useApplicationStore();
        (store.activeEditor as any).file = mockFile;

        await wrapper.vm.$nextTick();

        // Count options in dropdown
        const options = wrapper.findAll(".data-item-dropdown option");

        // Should have 1 placeholder + 1 available (di-3) = 2 total
        expect(options.length).toBe(2);

        // Verify di-3 is available (only item not selected)
        const availableOption = options.find(opt => (opt.element as HTMLOptionElement).value === "di-3");
        expect(availableOption).toBeDefined();
    });

    it("AC4.6: renaming an endpoint updates the label reactively via subscription", async () => {
        const wrapper = mount(DataItemRefListField, {
            props: {
                property: mockRefListProperty,
                context: {
                    node1View: mockNode1View as BlockView,
                    node2View: mockNode2View as BlockView,
                    direction: "node1ToNode2"
                }
            },
            global: {
                plugins: [createTestingPinia({ stubActions: false, createSpy: vi.fn })]
            }
        });

        const store = useApplicationStore();
        (store.activeEditor as any).file = mockFile;

        await wrapper.vm.$nextTick();

        let label = wrapper.find(".direction-label").text();
        expect(label).toBe("Data from Source to Target");

        // Now mutate the name property
        const node1Properties = mockNode1View.properties as any;
        const node1NameProp = node1Properties.value.get("name") as StringProperty;
        node1NameProp.setValue("AA");

        // The component's subscription handler should have incremented updateCounter,
        // invalidating the label computed property cache and triggering a re-render.
        // Wait for Vue to process the update.
        await wrapper.vm.$nextTick();

        // Label should reflect the change without needing to update props
        label = wrapper.find(".direction-label").text();
        expect(label).toBe("Data from AA to Target");
    });

    it("AC4.7: empty diagram shows the empty-state hint", async () => {
        // Create a file with NO data items
        const emptyFile = {
            canvas: {
                properties: {
                    value: new Map()
                }
            }
        } as unknown as Partial<DiagramViewFile>;

        const wrapper = mount(DataItemRefListField, {
            props: {
                property: mockRefListProperty,
                context: {
                    node1View: mockNode1View as BlockView,
                    node2View: mockNode2View as BlockView,
                    direction: "node1ToNode2"
                }
            },
            global: {
                plugins: [createTestingPinia({ stubActions: false, createSpy: vi.fn })]
            }
        });

        const store = useApplicationStore();
        (store.activeEditor as any).file = emptyFile;

        await wrapper.vm.$nextTick();

        // Assert: empty-state hint is visible
        const emptyState = wrapper.find(".empty-state");
        expect(emptyState.exists()).toBe(true);
        expect(emptyState.text()).toContain("No data items defined in this diagram");

        // Assert: dropdown is not visible (or hidden)
        const select = wrapper.find(".data-item-dropdown");
        expect(select.exists()).toBe(false);
    });

});
