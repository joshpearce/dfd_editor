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
import { DataItemParentRefProperty, RootProperty } from "@OpenChart/DiagramModel";
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
    const nameProp = block.properties.value.get("name");
    const val = nameProp?.toJson?.();
    return typeof val === "string" && val.trim() ? val.trim() : block.id;
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
            subscriptionId: "",
            blockSubscriptionIds: [] as Array<{ props: RootProperty; id: string }>,
            updateCounter: 0
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
        subscribeAll(): void {
            this.unsubscribeAll();
            const canvas = this.store.activeEditor?.file?.canvas as CanvasView | undefined;
            if (!canvas) return;
            const handler = () => { this.updateCounter++; };

            const canvasSubId = crypto.randomUUID();
            this.subscriptionId = canvasSubId;
            if (typeof (canvas.properties as RootProperty).subscribe === "function") {
                (canvas.properties as RootProperty).subscribe(canvasSubId, handler);
            }

            for (const block of collectEligibleBlocks(canvas)) {
                const blockSubId = crypto.randomUUID();
                const blockProps = block.properties as RootProperty;
                if (typeof blockProps.subscribe === "function") {
                    blockProps.subscribe(blockSubId, handler);
                    this.blockSubscriptionIds.push({ props: blockProps, id: blockSubId });
                }
            }
        },
        unsubscribeAll(): void {
            const canvas = this.store.activeEditor?.file?.canvas as CanvasView | undefined;
            if (canvas && this.subscriptionId) {
                const canvasProps = canvas.properties as RootProperty;
                if (typeof canvasProps.unsubscribe === "function") {
                    canvasProps.unsubscribe(this.subscriptionId);
                }
                this.subscriptionId = "";
            }
            for (const { props, id } of this.blockSubscriptionIds) {
                if (typeof props.unsubscribe === "function") {
                    props.unsubscribe(id);
                }
            }
            this.blockSubscriptionIds = [];
        }
    },
    watch: {
        "store.activeEditor.file.canvas": {
            handler() {
                this.subscribeAll();
            },
            immediate: true
        }
    },
    unmounted() {
        this.unsubscribeAll();
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
