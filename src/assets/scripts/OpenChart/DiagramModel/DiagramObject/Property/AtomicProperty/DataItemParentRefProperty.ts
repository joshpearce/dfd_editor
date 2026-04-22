// pattern: Functional Core

import { StringProperty } from "./StringProperty";

/**
 * Reference to a single parent element GUID on a Data Item. Runtime shape
 * identical to StringProperty; the distinct class lets the property editor
 * dispatch to DataItemParentRefField (while StringProperty still renders
 * TextField).
 */
export class DataItemParentRefProperty extends StringProperty {

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
