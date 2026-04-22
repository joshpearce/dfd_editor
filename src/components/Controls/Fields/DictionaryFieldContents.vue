<template>
  <div class="dictionary-field-contents-control">
    <div
      class="field-item"
      v-for="[key, value] in fields"
      :key="key"
    >
      <p class="field-name">
        {{ value.name }}
      </p>
      <component
        class="field-value"
        :is="getField(value)"
        :property="value"
        :context="contextFor(key, value)"
        @execute="(cmd: SynchronousEditorCommand) => $emit('execute', cmd)"
      />
    </div>
  </div>
</template>

<script lang="ts">
// Dependencies
import { defineAsyncComponent, defineComponent, type PropType } from "vue";
import {
  DateProperty, DictionaryProperty, EnumProperty,
  FloatProperty, IntProperty, ListProperty, StringProperty,
  TupleProperty, DataItemRefListProperty, DataItemParentRefProperty
} from "@OpenChart/DiagramModel";
import type { Property } from "@OpenChart/DiagramModel";
import type { SynchronousEditorCommand } from "@OpenChart/DiagramEditor";
// Components
import TextField from "./TextField.vue";
import ListField from "./ListField.vue";
import EnumField from "./EnumField.vue";
import TupleField from "./TupleField.vue";
import NumberField from "./NumberField.vue";
import DateTimeField from "./DateTimeField.vue";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DictionaryField = defineAsyncComponent(() => import("./DictionaryField.vue")) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DataItemRefListField = defineAsyncComponent(() => import("./DataItemRefListField.vue")) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DataItemParentRefField = defineAsyncComponent(() => import("./DataItemParentRefField.vue")) as any;

export default defineComponent({
  name: "DictionaryFieldContents",
  props: {
    property: {
      type: Object as PropType<DictionaryProperty>,
      required: true
    },
    context: {
      type: Object as PropType<Record<string, unknown>>,
      default: () => ({})
    }
  },
  computed: {
    
    /**
     * The set of visible properties.
     * @returns
     *  The set of visible properties.
     */
    fields(): [string, Property][] {
      return [...this.property.value.entries()].filter(
        o => o[1].isEditable ?? true
      );
    }

  },
  emits: {
    execute: (cmd: SynchronousEditorCommand) => cmd
  },
  methods: {
   
    /**
     * Returns a field's component type.
     * @param type
     *  The type of field.
     * @returns
     *  The field's component type.
     */
    getField(type: Property): string | undefined {
      switch(type.constructor.name) {
        case StringProperty.name:
          return "TextField";
        case IntProperty.name:
        case FloatProperty.name:
          return "NumberField";
        case DateProperty.name:
          return "DateTimeField";
        case EnumProperty.name:
          return "EnumField";
        case DataItemRefListProperty.name:
          return "DataItemRefListField";
        case DataItemParentRefProperty.name:
          return "DataItemParentRefField";
        case ListProperty.name:
          return "ListField";
        case TupleProperty.name:
          return "TupleField";
        case DictionaryProperty.name:
          return "DictionaryField";
      }
    },

    /**
     * Returns context for a subproperty if applicable.
     * @param key
     *  The property key.
     * @param subprop
     *  The subproperty.
     * @returns
     *  Context object if this is a DataItemRefListProperty, undefined otherwise.
     */
    contextFor(key: string, subprop: Property): Record<string, unknown> | undefined {
      if (subprop instanceof DataItemRefListProperty) {
        return (this.context[key] as Record<string, unknown>) || undefined;
      }
      return undefined;
    }

  },
  components: {
    TextField,
    ListField,
    EnumField,
    TupleField,
    NumberField,
    DateTimeField,
    DictionaryField,
    DataItemRefListField,
    DataItemParentRefField
  }
});
</script>

<style scoped>

/** === Main Field === */

.field-item {
  margin-bottom: 14px;
}

.field-item:last-child {
  margin-bottom: 0px;
}

.field-name {
  color: #bfbfbf;
  font-size: 11pt;
  font-weight: 600;
  letter-spacing: 0.05em;
  margin-bottom: 6px;
}

.field-value {
  font-size: 9pt;
}

.text-field-control,
.enum-field-control,
.number-field-control,
.datetime-field-control,
.tuple-field-control {
  min-height: 30px;
  border-radius: 4px;
  background: #2e2e2e;
}

</style>
