<template>
  <section class="data-item-ref-list-field">
    <h4 class="direction-label">
      {{ label }}
    </h4>

    <ul
      v-if="property.value.size > 0"
      class="selected-items"
    >
      <li
        v-for="[key, prop] in property.value"
        :key="key"
        class="selected-item"
      >
        <span class="chip">{{ resolveName(prop) }}</span>
        <button
          type="button"
          class="delete-button"
          @click="onDelete(key)"
          aria-label="Remove"
        >
          ×
        </button>
      </li>
    </ul>

    <div
      v-if="availableDataItems.length === 0 && property.value.size === 0"
      class="empty-state"
    >
      No data items defined in this diagram. Import a diagram with data items to select references.
    </div>

    <select
      v-else
      class="data-item-dropdown"
      @change="onSelect(($event.target as HTMLSelectElement).value)"
    >
      <option
        value=""
        disabled
        selected
      >
        Add data item…
      </option>
      <option
        v-for="opt in dropdownOptions"
        :key="opt.value"
        :value="opt.value"
      >
        {{ opt.text }}
      </option>
    </select>
  </section>
</template>

<script lang="ts">
import { defineComponent, type PropType } from "vue";
import { useApplicationStore } from "@/stores/ApplicationStore";
import * as EditorCommands from "@OpenChart/DiagramEditor";
import { DataItemRefListProperty, StringProperty } from "@OpenChart/DiagramModel";
import type { BlockView } from "@OpenChart/DiagramView";
import type { SynchronousEditorCommand } from "@OpenChart/DiagramEditor";
import type { DataItem } from "@OpenChart/DiagramModel/DataItemLookup";

interface DataItemRefFieldContext {
  node1View: BlockView;
  node2View: BlockView;
  direction: "node1ToNode2" | "node2ToNode1";
}

export default defineComponent({
  name: "DataItemRefListField",
  props: {
    property: {
      type: Object as PropType<DataItemRefListProperty>,
      required: true
    },
    context: {
      type: Object as PropType<DataItemRefFieldContext>,
      required: true
    }
  },
  emits: {
    execute: (cmd: SynchronousEditorCommand) => cmd
  },
  data() {
    return {
      store: useApplicationStore()
    };
  },
  computed: {
    /**
     * Direction label showing "Data from X to Y".
     */
    label(): string {
      const from =
        this.context.direction === "node1ToNode2"
          ? this.blockName(this.context.node1View)
          : this.blockName(this.context.node2View);
      const to =
        this.context.direction === "node1ToNode2"
          ? this.blockName(this.context.node2View)
          : this.blockName(this.context.node1View);
      return `Data from ${from} to ${to}`;
    },

    /**
     * Available data items from the canvas.
     */
    availableDataItems(): DataItem[] {
      return this.store.activeDataItems;
    },

    /**
     * Set of already-selected data-item GUIDs.
     */
    alreadySelected(): Set<string> {
      const selected = new Set<string>();
      for (const [, prop] of this.property.value) {
        const guid = (prop as StringProperty).toJson();
        if (typeof guid === "string" && guid.length > 0) {
          selected.add(guid);
        }
      }
      return selected;
    },

    /**
     * Dropdown options (filtered to hide already-selected items).
     */
    dropdownOptions(): Array<{ value: string; text: string }> {
      return this.availableDataItems
        .filter(di => !this.alreadySelected.has(di.guid))
        .map(di => ({ value: di.guid, text: di.name ?? "(unnamed)" }));
    }
  },
  watch: {
    /**
     * Watch for changes in endpoint names to trigger re-render of label.
     */
    "context.node1View.properties.value": {
      handler() {
        // Trigger re-render by accessing label property
        void this.$forceUpdate?.();
      },
      deep: true
    },
    "context.node2View.properties.value": {
      handler() {
        void this.$forceUpdate?.();
      },
      deep: true
    }
  },
  methods: {
    /**
     * Get the display name of a block.
     */
    blockName(view: BlockView): string {
      const nameProperty = view.properties.value.get("name");
      const nameValue = nameProperty?.toJson?.();
      const name = typeof nameValue === "string" && nameValue.trim()
        ? nameValue
        : "Unnamed";
      return name;
    },

    /**
     * Resolve the display name of a data item ref.
     */
    resolveName(prop: unknown): string {
      if (!(prop instanceof StringProperty)) {
        return "(invalid)";
      }
      const guid = prop.toJson();
      const item = this.availableDataItems.find(di => di.guid === guid);
      if (item) {
        return item.name || "(unnamed)";
      }
      // Dangling ref
      return `?${String(guid).substring(0, 8)}`;
    },

    /**
     * Handle dropdown selection.
     */
    onSelect(guid: string): void {
      if (!guid) return;
      const cmd = EditorCommands.addDataItemRef(this.property, guid);
      this.$emit("execute", cmd);
      // Reset the dropdown selection
      const select = this.$el.querySelector(".data-item-dropdown") as HTMLSelectElement;
      if (select) {
        select.value = "";
      }
    },

    /**
     * Handle delete button click.
     */
    onDelete(key: string): void {
      const cmd = EditorCommands.deleteSubproperty(this.property, key);
      this.$emit("execute", cmd);
    }
  }
});
</script>

<style scoped>
.data-item-ref-list-field {
  margin-bottom: 18px;
}

.direction-label {
  color: #a6a6a6;
  font-size: 9.5pt;
  font-weight: 500;
  margin: 0 0 8px 0;
}

.selected-items {
  list-style: none;
  margin: 0 0 8px 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.selected-item {
  display: flex;
  align-items: center;
  gap: 4px;
  background: #3a3a3a;
  border-radius: 4px;
  padding: 4px 8px;
}

.chip {
  color: #d0d0d0;
  font-size: 10pt;
}

.delete-button {
  background: none;
  border: none;
  color: #888;
  cursor: pointer;
  font-size: 12pt;
  padding: 0 2px;
  line-height: 1;
  transition: color 0.2s;
}

.delete-button:hover {
  color: #e0e0e0;
}

.empty-state {
  color: #888;
  font-size: 10pt;
  padding: 8px;
  font-style: italic;
  text-align: center;
}

.data-item-dropdown {
  width: 100%;
  padding: 6px 8px;
  border-radius: 4px;
  background: #2e2e2e;
  color: #d0d0d0;
  border: 1px solid #404040;
  font-size: 10.5pt;
  cursor: pointer;
}

.data-item-dropdown:hover {
  border-color: #505050;
}

.data-item-dropdown:focus {
  outline: none;
  border-color: #606060;
  background: #333;
}
</style>
