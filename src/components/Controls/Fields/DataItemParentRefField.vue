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

import { defineComponent, type PropType } from "vue";
import { useApplicationStore } from "@/stores/ApplicationStore";
import { DataItemParentRefProperty } from "@OpenChart/DiagramModel";
import * as EditorCommands from "@OpenChart/DiagramEditor";
import type { SynchronousEditorCommand } from "@OpenChart/DiagramEditor";
import type { DiagramViewEditor } from "@OpenChart/DiagramEditor";
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
    data() {
        return {
            store: useApplicationStore(),
            updateCounter: 0,
            editListener: null as ((...args: unknown[]) => void) | null,
            attachedEditor: null as DiagramViewEditor | null
        };
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
            return result;
        }
    },
    methods: {
        onChange(guid: string): void {
            const cmd = EditorCommands.setStringProperty(this.property, guid === "" ? null : guid);
            this.$emit("execute", cmd);
        },
        attachEditListener(): void {
            this.detachEditListener();
            const editor = this.store.activeEditor as DiagramViewEditor | undefined;
            if (!editor || typeof editor.on !== "function") return;
            const handler = () => { this.updateCounter++; };
            editor.on("edit", handler);
            this.editListener = handler;
            this.attachedEditor = editor;
        },
        detachEditListener(): void {
            const editor = this.attachedEditor;
            if (!editor || !this.editListener || typeof editor.removeEventListener !== "function") return;
            editor.removeEventListener("edit", this.editListener);
            this.editListener = null;
            this.attachedEditor = null;
        }
    },
    watch: {
        "store.activeEditor": {
            handler() {
                this.attachEditListener();
            },
            immediate: true
        }
    },
    unmounted() {
        this.detachEditListener();
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
