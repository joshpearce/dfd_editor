<template>
  <AccordionBox class="editor-tabs-element">
    <AccordionPane
      name="Properties"
      :units="3"
    >
      <div class="properties-pane">
        <PropertyEditor
          ref="propertyEditor"
          :property="selected"
          :context="fieldContext"
        >
          <template #no-props>
            The selected object has no properties.
          </template>
          <template #no-prop>
            Select a single object to edit its properties.
          </template>
        </PropertyEditor>
        <OwnedDataItemsSection
          v-if="ownedDataItemsSectionBlockGuid"
          :block-guid="ownedDataItemsSectionBlockGuid"
          @execute="(cmd) => application.execute(cmd)"
        />
      </div>
    </AccordionPane>
    <AccordionPane
      name="Problems"
      :units="1"
    >
      <ValidatorProblems class="validator-problems-pane" />
    </AccordionPane>
  </AccordionBox>
</template>

<script lang="ts">
// Dependencies
import { defineComponent } from "vue";
import { useApplicationStore } from "@/stores/ApplicationStore";
import { LineView, BlockView } from "@OpenChart/DiagramView";
import type { DictionaryProperty } from "@OpenChart/DiagramModel";
// Components
import AccordionBox from "@/components/Containers/AccordionBox.vue";
import AccordionPane from "@/components/Containers/AccordionPane.vue";
import PropertyEditor from "@/components/Elements/PropertyEditor.vue";
import ValidatorProblems from "@/components/Elements/ValidatorProblems.vue";
import OwnedDataItemsSection from "@/components/Controls/Fields/OwnedDataItemsSection.vue";

export default defineComponent({
  name: "EditorSidebar",
  data() {
    return {
      application: useApplicationStore()
    }
  },
  computed: {

    /**
     * Returns the currently selected object's properties.
     * @returns
     *  The currently selected object's properties.
     */
    selected(): DictionaryProperty | undefined {
      const hasSelection = this.application.hasSelection;
      if(hasSelection === 0) {
        return this.application.activeEditor.file.canvas.properties;
      } else if(hasSelection === 1) {
        return this.application.getSelection[0].properties;
      }
      return undefined;
    },

    /**
     * Returns the block GUID if the sole selection is an eligible element
     * (process / external_entity / data_store), or null otherwise.
     */
    ownedDataItemsSectionBlockGuid(): string | null {
      if (this.application.hasSelection !== 1) return null;
      const obj = this.application.getSelection[0];
      if (!(obj instanceof BlockView)) return null;
      if (!["process", "external_entity", "data_store"].includes(obj.id)) return null;
      return obj.instance;
    },

    /**
     * Computes context for data-item ref fields when a Line is selected.
     * @returns
     *  Context object keyed by property name, or empty object if no Line selected.
     */
    fieldContext(): Record<string, unknown> {
      const app = this.application;
      if (app.hasSelection !== 1) return {};
      const obj = app.getSelection[0];
      if (!(obj instanceof LineView)) return {};
      const node1View = obj.node1Object as BlockView | null;
      const node2View = obj.node2Object as BlockView | null;
      if (!node1View || !node2View) return {};
      return {
        node1_src_data_item_refs: { node1View, node2View, direction: "node1ToNode2" },
        node2_src_data_item_refs: { node1View, node2View, direction: "node2ToNode1" }
      };
    }

  },
  watch: {
    /**
     * When a spawn requests focus, find the first editable input/textarea
     * inside the property editor and focus it. The selection-driven render
     * happens on the same tick as the request, so we wait one nextTick.
     */
    "application.pendingNameFocus"() {
      void this.$nextTick(() => {
        const root = (this.$refs.propertyEditor as { $el?: HTMLElement } | undefined)?.$el;
        const target = root?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
          "input:not([disabled]), textarea:not([disabled])"
        );
        if (target) {
          target.focus();
          target.select?.();
        }
      });
    }
  },
  components: {
    AccordionBox,
    AccordionPane,
    PropertyEditor,
    ValidatorProblems,
    OwnedDataItemsSection
  }
});
</script>

<style scoped>

/** === Main Element === */

.editor-tabs-element {
  border-left: solid 1px #303030;
  background: #242424;
}

.properties-pane,
.validator-problems-pane {
  height: 100%;
}

</style>
