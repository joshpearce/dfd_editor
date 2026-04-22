<template>
  <section class="owned-data-items-section">
    <h4 class="section-title">
      Data Items
    </h4>
    <ul
      v-if="ownedItems.length > 0"
      class="owned-list"
    >
      <li
        v-for="item in ownedItems"
        :key="item.guid"
        class="owned-chip"
      >
        <span class="chip-label">{{ item.name || item.identifier || item.guid.slice(0, 8) }}</span>
        <button
          type="button"
          class="delete-button"
          aria-label="Remove"
          @click="onUnown(item.guid)"
        >
          ×
        </button>
      </li>
    </ul>
    <div
      v-else
      class="empty-state"
    >
      No data items owned by this element.
    </div>
    <select
      v-if="unownedItems.length > 0"
      class="data-item-dropdown"
      @change="onSelectChange"
    >
      <option
        value=""
        disabled
        selected
      >
        Add unowned data item…
      </option>
      <option
        v-for="item in unownedItems"
        :key="item.guid"
        :value="item.guid"
      >
        {{ item.name || item.identifier || item.guid.slice(0, 8) }}
      </option>
    </select>
  </section>
</template>

<script lang="ts">
// pattern: Imperative Shell

import { defineComponent, ref } from "vue";
import { useApplicationStore } from "@/stores/ApplicationStore";
import { useEditorEditEvent } from "@/composables/useEditorEditEvent";
import { ListProperty, DictionaryProperty, StringProperty } from "@OpenChart/DiagramModel";
import * as EditorCommands from "@OpenChart/DiagramEditor";
import type { SynchronousEditorCommand } from "@OpenChart/DiagramEditor";
import type { DataItem } from "@OpenChart/DiagramModel/DataItemLookup";
import { dataItemsForParent, readDataItems } from "@OpenChart/DiagramModel/DataItemLookup";
import type { Canvas } from "@OpenChart/DiagramModel";

export default defineComponent({
    name: "OwnedDataItemsSection",
    props: {
        blockGuid: {
            type: String,
            required: true
        }
    },
    emits: {
        execute: (cmd: SynchronousEditorCommand) => cmd
    },
    setup() {
        const store = useApplicationStore();
        const updateCounter = ref(0);
        useEditorEditEvent(store, () => { updateCounter.value++; });
        return { store, updateCounter };
    },
    computed: {
        canvas(): Canvas | undefined {
            return this.store.activeEditor?.file?.canvas as Canvas | undefined;
        },
        ownedItems(): DataItem[] {
            void this.updateCounter;
            const canvas = this.canvas;
            if (!canvas) return [];
            return dataItemsForParent(canvas, this.blockGuid);
        },
        unownedItems(): DataItem[] {
            void this.updateCounter;
            const canvas = this.canvas;
            if (!canvas) return [];
            return readDataItems(canvas).filter(item => !item.parent);
        }
    },
    methods: {
        onSelectChange(e: Event): void {
            const select = e.target as HTMLSelectElement;
            this.onAdopt(select.value);
            select.value = "";
        },
        parentProperty(itemGuid: string): StringProperty | null {
            const canvas = this.canvas;
            if (!canvas) return null;
            const listProp = canvas.properties.value.get("data_items");
            if (!(listProp instanceof ListProperty)) return null;
            const dict = listProp.value.get(itemGuid);
            if (!(dict instanceof DictionaryProperty)) return null;
            const parentProp = dict.value.get("parent");
            if (!(parentProp instanceof StringProperty)) return null;
            return parentProp;
        },
        onAdopt(guid: string): void {
            if (!guid) return;
            const prop = this.parentProperty(guid);
            if (!prop) return;
            this.$emit("execute", EditorCommands.setStringProperty(prop, this.blockGuid));
        },
        onUnown(guid: string): void {
            const prop = this.parentProperty(guid);
            if (!prop) return;
            this.$emit("execute", EditorCommands.setStringProperty(prop, null));
        }
    }
});
</script>

<style scoped>
.owned-data-items-section {
  margin-bottom: 18px;
  padding: 0 16px;
}

.section-title {
  color: #a6a6a6;
  font-size: 9.5pt;
  font-weight: 500;
  margin: 0 0 8px 0;
}

.owned-list {
  list-style: none;
  margin: 0 0 8px 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.owned-chip {
  display: flex;
  align-items: center;
  gap: 4px;
  background: #3a3a3a;
  border-radius: 4px;
  padding: 4px 8px;
}

.chip-label {
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
