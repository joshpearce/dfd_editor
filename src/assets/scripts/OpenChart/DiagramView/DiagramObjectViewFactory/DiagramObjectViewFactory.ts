import { FaceType } from "./FaceType";
import {
    DiagramObjectFactory, DiagramObjectType, traversePostfix
} from "@OpenChart/DiagramModel";
import {
    AnchorPoint, AnchorView, BlockView, BranchBlock,
    CanvasView, DictionaryBlock, DotGridCanvas, DynamicLine,
    GroupFace, GroupView, HandlePoint, HandleView,
    LatchPoint, LatchView, LineGridCanvas, LineView, PolyLine, TextBlock
} from "../DiagramObjectView";
import type { FaceDesign } from "./FaceDesign";
import type { Constructor } from "@OpenChart/Utilities";
import type { DiagramTheme } from "./DiagramTheme";
import type { TypeToTemplate } from "./TypeToTemplate";
import type { DiagramObjectView } from "../DiagramObjectView";
import type {
    DiagramObjectTemplate, DiagramSchemaConfiguration, JsonEntries
} from "@OpenChart/DiagramModel";

export class DiagramObjectViewFactory extends DiagramObjectFactory {

    /**
     * The factory's theme.
     */
    public theme: DiagramTheme;


    /**
     * Creates a new {@link DiagramViewFactory}.
     * @param schema
     *  The factory's schema.
     * @param theme
     *  The factory's theme.
     */
    constructor(schema: DiagramSchemaConfiguration, theme: DiagramTheme) {
        super(schema);
        this.theme = theme;
    }


    ///////////////////////////////////////////////////////////////////////////
    //  1. Object Creation  ///////////////////////////////////////////////////
    ///////////////////////////////////////////////////////////////////////////


    /**
     * Creates a new {@link DiagramObjectView}.
     * @param name
     *  The template's name.
     * @param type
     *  The expected {@link DiagramObjectView} sub-type.
     *  (Default: `DiagramObjectView`)
     * @returns
     *  The {@link DiagramObjectView}.
     */
    public override createNewDiagramObject<T extends DiagramObjectView>(
        name: string,
        type?: Constructor<T>
    ): T;

    /**
     * Creates a new {@link DiagramObjectView}.
     * @param template
     *  The template.
     * @param type
     *  The expected {@link DiagramObjectView} sub-type.
     *  (Default: `DiagramObjectView`)
     * @returns
     *  The {@link DiagramObjectView}.
     */
    public override createNewDiagramObject<T extends DiagramObjectView>(
        template: DiagramObjectTemplate | string,
        type?: Constructor<T>
    ): T {
        return super.createNewDiagramObject(template, type);
    }

    /**
     * Configures a new {@link DiagramObjectView}.
     * @remarks
     *  This function only constructs the object directly defined by the
     *  template. This function does not generate or attach implied children.
     *  For example, generating a text block results in an anchor-less
     *  {@link BlockView}.
     * @param template
     *  The template.
     * @param type
     *  The expected {@link DiagramObjectView} sub-type.
     *  (Default: `DiagramObjectView`)
     */
    public createBaseDiagramObject<T extends DiagramObjectView>(
        template: DiagramObjectTemplate,
        type?: Constructor<T>
    ): T;

    /**
     * Configures a new {@link DiagramObjectView}.
     * @remarks
     *  This function only constructs the object directly defined by the
     *  template. This function does not generate or attach implied children.
     *  For example, generating a text block results in an anchor-less
     *  {@link BlockView}.
     * @param name
     *  The template's name.
     * @param instance
     *  The object's instance id.
     *  (Default: Randomly Generated UUID).
     * @param values
     *  The object's property values.
     * @param type
     *  The expected {@link DiagramObjectView} sub-type.
     *  (Default: `DiagramObjectView`)
     */
    public createBaseDiagramObject<T extends DiagramObjectView>(
        name: string,
        instance?: string,
        values?: JsonEntries,
        type?: Constructor<T>
    ): T;

    /**
     * Configures a new {@link DiagramObjectView}.
     * @remarks
     *  This function only constructs the object directly defined by the
     *  template. This function does not generate or attach implied children.
     *  For example, generating a text block results in an anchor-less
     *  {@link BlockView}.
     * @param template
     *  The template.
     * @param instance
     *  The object's instance id.
     *  (Default: Randomly Generated UUID).
     * @param values
     *  The object's property values.
     * @param type
     *  The expected {@link DiagramObjectView} sub-type.
     *  (Default: `DiagramObjectView`)
     */
    public createBaseDiagramObject<T extends DiagramObjectView>(
        template: DiagramObjectTemplate | string,
        instance?: string,
        values?: JsonEntries,
        type?: Constructor<T>
    ): T;

    /**
     * Configures a new {@link DiagramObjectView}.
     * @remarks
     *  This base definition is intended for child classes.
     */
    public createBaseDiagramObject<T extends DiagramObjectView>(
        name: DiagramObjectTemplate | string,
        param1?: Constructor<T> | string,
        param2?: JsonEntries,
        param3?: Constructor<T>
    ): T;

    public createBaseDiagramObject<T extends DiagramObjectView>(
        name: DiagramObjectTemplate | string,
        param1?: Constructor<T> | string,
        param2?: JsonEntries,
        param3?: Constructor<T>
    ): T {
        return super.createBaseDiagramObject(name, param1, param2, param3);
    }

    /**
     * Creates a new {@link DiagramObjectView} from a template.
     * @param template
     *  The {@link DiagramObjectTemplate}.
     * @returns
     *  The {@link DiagramObjectView}.
     */
    protected override createNewDiagramObjectFromTemplate(
        template: DiagramObjectTemplate
    ): DiagramObjectView {
        // Resolve design
        const design = this.resolveDesign(template.name);
        // Create object
        let object;
        switch (design.type) {

            case FaceType.DictionaryBlock:
            case FaceType.BranchBlock:
            case FaceType.TextBlock:
                // Assert template
                this.assertTemplateMatchesFace(template, design.type);
                // Create object
                object = this.createBaseDiagramObject(template, BlockView);
                // Attach anchors
                const { anchors } = template;
                for (const position in anchors) {
                    const anchor = this.createNewDiagramObject(anchors[position], AnchorView);
                    object.addAnchor(position, anchor);
                }
                return object;

            case FaceType.DynamicLine:
            case FaceType.PolyLine:
                // Assert template
                this.assertTemplateMatchesFace(template, design.type);
                // Create object
                object = this.createBaseDiagramObject(template, LineView);
                // Create latches
                const latch = template.latch_template;
                object.node1 = this.createNewDiagramObject(latch.node1, LatchView);
                object.node2 = this.createNewDiagramObject(latch.node2, LatchView);
                // Attach reference handle
                const handle = template.handle_template;
                object.addHandle(this.createNewDiagramObject(handle, HandleView));
                // Provide line volume
                object.node2.moveBy(100, 100);
                break;

            default:
                this.assertTemplateMatchesFace(template, design.type);
                object = this.createBaseDiagramObject(template);

        }
        return object;
    }

    /**
     * Configures a new {@link DiagramObjectView} from a template.
     * @param template
     *  The {@link DiagramObjectTemplate}.
     * @param instance
     *  The object's instance id.
     * @param values
     *  The object's property values.
     * @returns
     *  The {@link DiagramObjectView}.
     */
    protected override createBaseDiagramObjectFromTemplate(
        template: DiagramObjectTemplate,
        instance: string,
        values?: JsonEntries
    ): DiagramObjectView {
        const grid = this.theme.grid;
        const snapGrid = this.theme.snapGrid;
        const scale = this.theme.scale;
        // Create properties
        const props = this.createRootProperty(template.properties ?? {}, values);
        // Resolve design
        const design = this.resolveDesign(template.name);
        // Define attributes
        let attrs = 0;
        attrs |= template.attributes ?? 0;
        attrs |= design.attributes ?? 0;
        // Create object
        let face;
        switch (design.type) {
            case FaceType.AnchorPoint:
                face = new AnchorPoint(design.style);
                return new AnchorView(template.name, instance, attrs, props, face);
            case FaceType.BranchBlock:
                face = new BranchBlock(design.style, grid, scale);
                return new BlockView(template.name, instance, attrs, props, face);
            case FaceType.DictionaryBlock:
                face = new DictionaryBlock(design.style, grid, scale, design.properties);
                return new BlockView(template.name, instance, attrs, props, face);
            case FaceType.TextBlock:
                face = new TextBlock(design.style, grid, scale);
                return new BlockView(template.name, instance, attrs, props, face);
            case FaceType.HandlePoint:
                face = new HandlePoint(design.style);
                return new HandleView(template.name, instance, attrs, props, face);
            case FaceType.LatchPoint:
                face = new LatchPoint(design.style);
                return new LatchView(template.name, instance, attrs, props, face);
            case FaceType.DynamicLine:
                face = new DynamicLine(design.style, grid);
                return new LineView(template.name, instance, attrs, props, face);
            case FaceType.PolyLine:
                face = new PolyLine(design.style, grid);
                return new LineView(template.name, instance, attrs, props, face);
            case FaceType.Group:
                face = new GroupFace(design.style);
                return new GroupView(template.name, instance, attrs, props, face);
            case FaceType.LineGridCanvas:
                face = new LineGridCanvas(design.style, grid, scale, snapGrid);
                return new CanvasView(template.name, instance, attrs, props, face);
            case FaceType.DotGridCanvas:
                face = new DotGridCanvas(design.style, grid, scale, snapGrid);
                return new CanvasView(template.name, instance, attrs, props, face);
        }
    }

    /**
     * Resolves a template's design.
     * @param template
     *  The template's name.
     * @returns
     *  The template's design.
     */
    public resolveDesign(template: string): FaceDesign {
        if (template in this.theme.designs) {
            return this.theme.designs[template];
        } else {
            throw new Error(`Template '${template}' has no design.`);
        }
    }

    /**
     * Asserts that a design's face matches its template.
     * @param template
     *  The face's {@link DiagramObjectTemplate}.
     * @param face
     *  The face's type.
     */
    private assertTemplateMatchesFace<T extends keyof TypeToTemplate>(
        template: DiagramObjectTemplate,
        face: T
    ): asserts template is TypeToTemplate[T]  {
        const type = template.type;
        switch (face) {
            case FaceType.AnchorPoint:
                if (type === DiagramObjectType.Anchor) {
                    return;
                }
            case FaceType.BranchBlock:
            case FaceType.DictionaryBlock:
            case FaceType.TextBlock:
                if (type === DiagramObjectType.Block) {
                    return;
                }
            case FaceType.HandlePoint:
                if (type === DiagramObjectType.Handle) {
                    return;
                }
            case FaceType.DynamicLine:
            case FaceType.PolyLine:
                if (type === DiagramObjectType.Line) {
                    return;
                }
            case FaceType.LatchPoint:
                if (type === DiagramObjectType.Latch) {
                    return;
                }
            case FaceType.Group:
                if (type === DiagramObjectType.Group) {
                    return;
                }
            case FaceType.LineGridCanvas:
            case FaceType.DotGridCanvas:
                if (type === DiagramObjectType.Canvas) {
                    return;
                }
        }
        throw new Error(`'${face}' face incompatible with '${type}' object type.`);
    }


    ///////////////////////////////////////////////////////////////////////////
    //  2. Object Restyling  //////////////////////////////////////////////////
    ///////////////////////////////////////////////////////////////////////////


    /**
     * Restyles a set of {@link DiagramObjectView} according to the schema.
     * @param diagram
     *  The diagram objects.
     */
    public restyleDiagramObject(
        objects: DiagramObjectView[]
    ): void {
        const grid = this.theme.grid;
        const snapGrid = this.theme.snapGrid;
        const scale = this.theme.scale;
        // Restyle objects
        for (const object of traversePostfix(objects)) {
            // Resolve design
            const design = this.resolveDesign(object.id);
            // Cache relative position
            const x = object.x;
            const y = object.y;
            // Set face
            let face;
            switch (design.type) {
                case FaceType.AnchorPoint:
                    face = new AnchorPoint(design.style);
                    object.replaceFace(face);
                    break;
                case FaceType.BranchBlock:
                    face = new BranchBlock(design.style, grid, scale);
                    object.replaceFace(face);
                    break;
                case FaceType.DictionaryBlock:
                    face = new DictionaryBlock(design.style, grid, scale, design.properties);
                    object.replaceFace(face);
                    break;
                case FaceType.TextBlock:
                    face = new TextBlock(design.style, grid, scale);
                    object.replaceFace(face);
                    break;
                case FaceType.HandlePoint:
                    face = new HandlePoint(design.style);
                    object.replaceFace(face);
                    break;
                case FaceType.LatchPoint:
                    face = new LatchPoint(design.style);
                    object.replaceFace(face);
                    break;
                case FaceType.DynamicLine:
                case FaceType.PolyLine: {
                    // Preserve runtime face inference across restyle: a
                    // line that was upgraded to PolyLine because it has
                    // two or more handles must stay a PolyLine after the
                    // theme swap, even when the new design declares
                    // DynamicLine.  Building a DynamicLine here would
                    // trigger view.dropHandles(1) on the next layout
                    // tick (called below) and lose the user's bends.
                    const wantsPolyLine
                        = object instanceof LineView
                        && object.handles.length >= 2;
                    face = wantsPolyLine
                        ? new PolyLine(design.style, grid)
                        : new DynamicLine(design.style, grid);
                    object.replaceFace(face);
                    break;
                }
                case FaceType.Group: {
                    // Rebuild with the new design's style, but preserve the
                    // user-chosen bounds from the old face.
                    const oldFace = object.face as GroupFace;
                    const [xMin, yMin, xMax, yMax] = oldFace.userBounds;
                    face = new GroupFace(design.style);
                    (face as GroupFace).setBounds(xMin, yMin, xMax, yMax);
                    object.replaceFace(face);
                    break;
                }
                case FaceType.LineGridCanvas:
                    face = new LineGridCanvas(design.style, grid, scale, snapGrid);
                    object.replaceFace(face);
                    break;
                case FaceType.DotGridCanvas:
                    face = new DotGridCanvas(design.style, grid, scale, snapGrid);
                    object.replaceFace(face);
                    break;
            }
            // Calculate layout
            object.calculateLayout();
            // Apply position
            if (face.userSetPosition) {
                object.moveTo(x, y);
            }
        }
    }


    ///////////////////////////////////////////////////////////////////////////
    //  3. Runtime Face Inference  ////////////////////////////////////////////
    ///////////////////////////////////////////////////////////////////////////


    /**
     * Walks every line in the supplied diagram subtree and selects between
     * {@link DynamicLine} and {@link PolyLine} based on the line's current
     * handle count.  A line with two or more handles becomes a PolyLine; a
     * line with one or zero handles becomes a DynamicLine.
     *
     * The face style and grid are taken from the line's existing template
     * design — themes never declare PolyLine directly, so the design carries
     * a `LineStyle` regardless of which face the line ends up using.
     *
     * Use this after any operation that mutates the handle list outside the
     * normal editor commands (auto-layout import, file load).  Idempotent —
     * a line whose face already matches the inference result is left alone.
     *
     * Lines whose template design is not a line face (defensive) are
     * skipped silently.
     */
    public inferLineFaces(roots: DiagramObjectView[]): void {
        const grid = this.theme.grid;
        for (const object of traversePostfix(roots)) {
            if (!(object instanceof LineView)) {
                continue;
            }
            // Skip lines whose template has no design in the current theme.
            // resolveDesign throws on unknown templates; we want to leave
            // those lines alone rather than abort the entire pass.
            let design;
            try {
                design = this.resolveDesign(object.id);
            } catch {
                continue;
            }
            if (design.type !== FaceType.DynamicLine && design.type !== FaceType.PolyLine) {
                continue;
            }
            const wantsPolyLine = object.handles.length >= 2;
            const isPolyLine = object.face instanceof PolyLine;
            if (wantsPolyLine === isPolyLine) {
                continue;
            }
            const newFace = wantsPolyLine
                ? new PolyLine(design.style, grid)
                : new DynamicLine(design.style, grid);
            object.replaceFace(newFace);
        }
    }

}
