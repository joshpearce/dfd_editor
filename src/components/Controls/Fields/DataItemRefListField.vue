<template>
  <section
    v-if="context"
    class="data-item-ref-list-field"
  >
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
import { DataItemRefListProperty, StringProperty, RootProperty } from "@OpenChart/DiagramModel";
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
      type: Object as PropType<DataItemRefFieldContext | undefined>,
      default: undefined
    }
  },
  emits: {
    execute: (cmd: SynchronousEditorCommand) => cmd
  },
  data() {
    return {
      store: useApplicationStore(),
      node1SubscriptionId: "",
      node2SubscriptionId: "",
      updateCounter: 0  // Incremented when properties change to invalidate computed cache
    };
  },
  computed: {
    /**
     * Direction label showing "Data from X to Y".
     * Depends on updateCounter to invalidate when endpoint properties change.
     */
    label(): string {
      // Access updateCounter to create reactive dependency on property changes
      void this.updateCounter;

      if (!this.context) {
        return "";
      }
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
     * Watch for context prop changes and re-subscribe to endpoint name changes.
     * This ensures we pick up new node references when the context is replaced.
     * Uses (newVal, oldVal) signature to properly unsubscribe from old context
     * before subscribing to the new one, preventing listener leaks.
     */
    context: {
      handler(newVal, oldVal) {
        if (oldVal) {
          this.unsubscribeFromProperties(oldVal);
        }
        if (newVal) {
          this.subscribeToProperties(newVal);
        }
      },
      deep: false
    }
  },
  methods: {
    /**
     * Subscribe to endpoint property changes using RootProperty.subscribe.
     * This bypasses Vue's reactivity limitations with the non-Vue OpenChart model.
     * Takes explicit context parameter to support both mounted() and watch handler calls.
     */
    subscribeToProperties(context: DataItemRefFieldContext): void {
      const handler = () => {
        // Increment counter to invalidate computed property cache, triggering re-render
        this.updateCounter++;
      };

      this.node1SubscriptionId = crypto.randomUUID();
      this.node2SubscriptionId = crypto.randomUUID();

      // Subscribe to the node1View's properties (RootProperty)
      const node1Props = context.node1View.properties as RootProperty;
      if (typeof node1Props.subscribe === "function") {
        node1Props.subscribe(this.node1SubscriptionId, handler);
      }

      // Subscribe to the node2View's properties (RootProperty)
      const node2Props = context.node2View.properties as RootProperty;
      if (typeof node2Props.subscribe === "function") {
        node2Props.subscribe(this.node2SubscriptionId, handler);
      }
    },

    /**
     * Unsubscribe from endpoint property changes for a specific context.
     * Takes explicit context parameter so it can unsubscribe from old context
     * values during prop swaps (preventing listener leaks).
     */
    unsubscribeFromProperties(context: DataItemRefFieldContext): void {
      const node1Props = context.node1View.properties as RootProperty;
      if (this.node1SubscriptionId && typeof node1Props.unsubscribe === "function") {
        node1Props.unsubscribe(this.node1SubscriptionId);
      }

      const node2Props = context.node2View.properties as RootProperty;
      if (this.node2SubscriptionId && typeof node2Props.unsubscribe === "function") {
        node2Props.unsubscribe(this.node2SubscriptionId);
      }

      this.node1SubscriptionId = "";
      this.node2SubscriptionId = "";
    },

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
  },
  mounted() {
    if (this.context) {
      this.subscribeToProperties(this.context);
    }
  },
  unmounted() {
    if (this.context) {
      this.unsubscribeFromProperties(this.context);
    }
  }
});
</script>

<style scoped>
.data-item-ref-list-field {
  margin-bottom: 18px;
}

.direction-label {
  color: #bfbfbf;
  font-size: 8.5pt;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
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
