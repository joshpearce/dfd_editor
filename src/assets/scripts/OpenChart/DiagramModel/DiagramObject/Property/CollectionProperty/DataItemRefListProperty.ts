import { ListProperty } from "./ListProperty";

/**
 * List of data-item GUID references carried by a Flow in one direction.
 * Identical runtime shape to ListProperty<StringProperty>; the distinct
 * class name lets the property editor dispatch to DataItemRefListField
 * (while ListProperty still renders the generic ListField).
 */
export class DataItemRefListProperty extends ListProperty {
    // No new fields or methods. Inherits everything from ListProperty.
}
