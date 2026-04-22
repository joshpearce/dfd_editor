// pattern: Functional Core

import { StringProperty } from "./StringProperty";
import type { StringPropertyOptions } from "./StringPropertyOptions";
import type { JsonValue } from "../JsonTypes";

/**
 * Reference to a single parent element GUID on a Data Item. Runtime shape
 * identical to StringProperty; the distinct class lets the property editor
 * dispatch to DataItemParentRefField (while StringProperty still renders
 * TextField).
 */
export class DataItemParentRefProperty extends StringProperty {

    /**
     * Creates a new {@link DataItemParentRefProperty}.
     * @param options
     *  The property's options.
     * @param value
     *  The property's value.
     */
    constructor(options: StringPropertyOptions, value?: JsonValue) {
        super(options, value);
    }

    /**
     * Returns a clone of the property.
     * @param id
     *  The property's id.
     * @returns
     *  A clone of the property.
     */
    public override clone(id: string = this.id): DataItemParentRefProperty {
        return new DataItemParentRefProperty({
            id       : id,
            name     : this.name,
            metadata : this.metadata,
            editable : this.isEditable,
            options  : this.options
        }, this.toJson());
    }

}
