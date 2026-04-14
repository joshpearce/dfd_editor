export type GroupStyle = {

    /**
     * Stroke color for the group's border.
     */
    strokeColor: string;

    /**
     * Stroke color when the group is focused (selected).
     */
    focusedStrokeColor: string;

    /**
     * Fill color applied only when the group is focused.
     */
    focusedFillColor: string;

    /**
     * Label color when idle.
     */
    labelColor: string;

    /**
     * Label color when focused.
     */
    focusedLabelColor: string;

    /**
     * Handle fill color for the 8 resize affordances when focused.
     */
    handleColor: string;

    /**
     * Line-dash pattern for the border. Empty array = solid.
     */
    lineDash: number[];

};
