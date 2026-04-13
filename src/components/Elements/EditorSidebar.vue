<template>
  <AccordionBox class="editor-tabs-element">
    <AccordionPane
      name="Properties"
      :units="3"
    >
      <PropertyEditor
        ref="propertyEditor"
        class="properties-pane"
        :property="selected"
      >
        <template #no-props>
          The selected object has no properties.
        </template>
        <template #no-prop>
          Select a single object to edit its properties.
        </template>
      </PropertyEditor>
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
import type { DictionaryProperty } from "@OpenChart/DiagramModel";
// Components
import AccordionBox from "@/components/Containers/AccordionBox.vue";
import AccordionPane from "@/components/Containers/AccordionPane.vue";
import PropertyEditor from "@/components/Elements/PropertyEditor.vue";
import ValidatorProblems from "@/components/Elements/ValidatorProblems.vue";

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
    ValidatorProblems
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
