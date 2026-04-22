<template>
  <div class="data-item-parent-ref-field">
    <select
      class="parent-ref-select"
      :value="currentValue"
      @change="onChange(($event.target as HTMLSelectElement).value)"
    >
      <option
        v-for="opt in options"
        :key="opt.value"
        :value="opt.value"
      >
        {{ opt.text }}
      </option>
    </select>
  </div>
</template>

<script lang="ts">
// pattern: Imperative Shell

import { defineComponent, ref, type PropType } from "vue";
import { useApplicationStore } from "@/stores/ApplicationStore";
import { useEditorEditEvent } from "@/composables/useEditorEditEvent";
import { DataItemParentRefProperty } from "@OpenChart/DiagramModel";
import * as EditorCommands from "@OpenChart/DiagramEditor";
import type { SynchronousEditorCommand } from "@OpenChart/DiagramEditor";
import type { CanvasView } from "@OpenChart/DiagramView";
import type { BlockView } from "@OpenChart/DiagramView";
import type { GroupView } from "@OpenChart/DiagramView";

const ELIGIBLE_TEMPLATES = new Set(["process", "external_entity", "data_store"]);

function collectEligibleBlocks(canvas: CanvasView): BlockView[] {
    const result: BlockView[] = [];

    function visitGroup(group: CanvasView | GroupView): void {
        for (const block of group.blocks) {
            if (ELIGIBLE_TEMPLATES.has(block.id)) {
                result.push(block as BlockView);
            }
        }
        for (const nested of group.groups) {
            visitGroup(nested as GroupView);
        }
    }

    visitGroup(canvas);
    return result;
}

function blockDisplayName(block: BlockView): string {
    const key = block.properties.representativeKey;
    if (!key) return block.instance.slice(0, 8);
    const prop = block.properties.value.get(key);
    const name = prop?.toJson?.();
    return typeof name === "string" && name.trim() ? name.trim() : block.instance.slice(0, 8);
}

export default defineComponent({
    name: "DataItemParentRefField",
    props: {
        property: {
            type: Object as PropType<DataItemParentRefProperty>,
            required: true
        }
    },
    emits: {
        execute: (cmd: SynchronousEditorCommand) => cmd
    },
    setup() {
        const store = useApplicationStore();
        // `updateCounter` is a reactive ref exposed to the template and to
        // Options API computed properties via the component instance.
        const updateCounter = ref(0);
        useEditorEditEvent(store, () => { updateCounter.value++; });
        return { store, updateCounter };
    },
    computed: {
        currentValue(): string {
            return this.property.toJson() ?? "";
        },
        options(): Array<{ value: string; text: string }> {
            void this.updateCounter;
            const canvas = this.store.activeEditor?.file?.canvas as CanvasView | undefined;
            const result: Array<{ value: string; text: string }> = [
                { value: "", text: "(unowned)" }
            ];
            if (!canvas) return result;
            for (const block of collectEligibleBlocks(canvas)) {
                result.push({
                    value: block.instance,
                    text: blockDisplayName(block)
                });
            }
            // If the current value is a non-empty GUID that does not match any
            // option, append a synthetic option so the select has a selected
            // entry — mirrors DataItemRefListField.resolveName's dangling-ref
            // display pattern.
            const current = this.property.toJson() ?? "";
            if (current && !result.some(opt => opt.value === current)) {
                result.push({ value: current, text: `?${current.slice(0, 8)}` });
            }
            return result;
        }
    },
    methods: {
        onChange(guid: string): void {
            const cmd = EditorCommands.setStringProperty(this.property, guid === "" ? null : guid);
            this.$emit("execute", cmd);
        }
    }
});
</script>

<style scoped>
.data-item-parent-ref-field {
  width: 100%;
}

.parent-ref-select {
  width: 100%;
  padding: 6px 8px;
  border-radius: 4px;
  background: #2e2e2e;
  color: #d0d0d0;
  border: 1px solid #404040;
  font-size: 10.5pt;
  cursor: pointer;
}

.parent-ref-select:hover {
  border-color: #505050;
}

.parent-ref-select:focus {
  outline: none;
  border-color: #606060;
  background: #333;
}
</style>
