import Configuration from "@/assets/configuration/app.configuration";
import { Device } from "@/assets/scripts/Browser";
import { DoNothing } from "../index.commands";
import { AppCommand } from "../index.commands";
import { stripExtension } from "@OpenChart/Utilities";
import { StixToAttackFlowConverter } from "@/assets/scripts/StixToAttackFlow";
import { DiagramObjectViewFactory, DiagramViewFile, NewAutoLayoutEngine } from "@OpenChart/DiagramView";
import { createDiagram, getDiagram, saveDiagram } from "@/assets/scripts/api/DfdApiClient";
import {
    BindEditorToServer,
    ClearFileRecoveryBank,
    ImportFile,
    LoadFile,
    PrepareEditorWithFile,
    PublishDiagramFileToDevice,
    RemoveFileFromRecoveryBank,
    SaveDiagramFileToDevice,
    SaveDiagramFileToServer,
    SaveDiagramImageToDevice,
    SaveSelectionImageToDevice
} from "./index.commands";
import type { StixBundle } from "@/assets/scripts/StixToAttackFlow";
import type { ApplicationStore } from "@/stores/ApplicationStore";
import type { DiagramViewExport } from "@OpenChart/DiagramView";
import type { DiagramViewEditor } from "@/assets/scripts/OpenChart/DiagramEditor";


///////////////////////////////////////////////////////////////////////////////
//  1. Open Files  ////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Loads an empty diagram file into the application.
 * @param context
 *  The application's context.
 * @returns
 *  A command that represents the action.
 */
export async function loadNewFile(
    context: ApplicationStore
): Promise<LoadFile> {
    // Construct file
    const file = new DiagramViewFile(await getObjectFactory(context));
    // Return command
    return new LoadFile(context, file);
}

/**
 * Loads a diagram file export into the application.
 * @param context
 *  The application's context.
 * @param file
 *  The file export.
 * @param name
 *  The file's name.
 * @returns
 *  A command that represents the action.
 */
export async function loadExistingFile(
    context: ApplicationStore, file: string, name?: string
): Promise<LoadFile> {
    let jsonFile = JSON.parse(file) as DiagramViewExport;
    // Preprocess file
    if (context.activeFilePreprocessor) {
        jsonFile = context.activeFilePreprocessor.process(jsonFile);
    }
    // Construct factory
    const factory = await getObjectFactory(context, jsonFile.schema);
    // Construct file
    const viewFile = new DiagramViewFile(factory, jsonFile);
    // Run layout
    if (!jsonFile.layout) {
        viewFile.runLayout(new NewAutoLayoutEngine());
    }
    // Return command
    return new LoadFile(context, viewFile, name);
}

/**
 * Loads a diagram file, from the file system, into the application.
 * @param context
 *  The application's context.
 * @returns
 *  A command that represents the action.
 */
export async function loadFileFromFileSystem(
    context: ApplicationStore
): Promise<AppCommand> {
    const file = await Device.openTextFileDialog(Configuration.file_type_extension);
    if (file) {
        const filename = stripExtension(file.filename);
        return loadExistingFile(context, file.contents as string, filename);
    } else {
        return new DoNothing();
    }
}

/**
 * Loads a diagram file, from a remote url, into the application.
 * @param context
 *  The application's context.
 * @param url
 *  The remote url.
 * @returns
 *  A command that represents the action.
 */
export async function loadFileFromUrl(
    context: ApplicationStore, url: string
): Promise<LoadFile> {
    const path = new URL(url).pathname.split(/\//g);
    // Parse filename
    let filename = path[path.length - 1];
    if (filename) {
        filename = stripExtension(decodeURI(filename));
    } else {
        filename = "Untitled File";
    }
    return loadExistingFile(context, await (await fetch(url)).text(), filename);
}

/**
 * Loads a diagram file, from the server, into the application.
 * @param context
 *  The application's context.
 * @param id
 *  The server-side diagram id.
 * @returns
 *  A command that represents the action.
 */
export async function loadFileFromServer(
    context: ApplicationStore, id: string
): Promise<LoadFile> {
    const contents = await getDiagram(id);
    return loadExistingFile(context, contents, id);
}

/**
 * Loads a STIX file into the application.
 * @param context
 *  The application's context.
 * @param file
 *  The STIX file.
 * @param name
 *  The file's name.
 * @returns
 *  A command that represents the action.
 */
export async function loadExistingStixFile(
    context: ApplicationStore, file: string, name?: string
): Promise<LoadFile> {
    const stixBundle = JSON.parse(file) as StixBundle;
    // Construct factory
    const factory = await getObjectFactory(context);
    // Translate STIX
    const jsonFile = new StixToAttackFlowConverter(factory).convert(stixBundle);
    // Construct file
    const viewFile = new DiagramViewFile(factory, jsonFile);
    // Return command
    return new LoadFile(context, viewFile, name);
}

/**
 * Loads a stix file, from the file system, into the application.
 * @param context
 *  The application's context.
 * @returns
 *  A command that represents the action.
 */
export async function loadStixFileFromFileSystem(
    context: ApplicationStore
): Promise<AppCommand> {
    const file = await Device.openTextFileDialog("json");
    if (file) {
        const filename = stripExtension(file.filename);
        return loadExistingStixFile(context, file.contents as string, filename);
    } else {
        return new DoNothing();
    }
}

/**
 * Returns the requested object factory.
 * @param context
 *  The application's context.
 * @param id
 *  The requested schema.
 *  (Default: The Primary Application Schema)
 * @returns
 */
async function getObjectFactory(
    context: ApplicationStore, id?: string
): Promise<DiagramObjectViewFactory> {
    // Resolve theme
    const themeId = context.settings.view.diagram.theme;
    const theme = await context.themeRegistry.getTheme(themeId);
    // Resolve schema
    const schema = Configuration.schema;
    if (id && id !== schema.id) {
        throw new Error(`Unsupported schema: '${id}'`);
    }
    // Construct factory
    return new DiagramObjectViewFactory(schema, theme);
}


///////////////////////////////////////////////////////////////////////////////
//  2. Import Files  //////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Imports a diagram file into an existing editor.
 * @param context
 *  The application context.
 * @param editor
 *  The editor to import into.
 * @param file
 *  The file to import.
 * @returns
 *  A command that represents the action.
 */
export async function importExistingFile(
    context: ApplicationStore, editor: DiagramViewEditor, file: string
): Promise<AppCommand> {
    // Parse file
    let jsonFile = JSON.parse(file) as DiagramViewExport;
    // Preprocess file
    if (context.activeFilePreprocessor) {
        jsonFile = context.activeFilePreprocessor.process(jsonFile);
    }
    // Construct factory
    const factory = await getObjectFactory(context, jsonFile.schema);
    // Construct file
    const viewFile = new DiagramViewFile(factory, jsonFile);
    // Run layout
    if (!jsonFile.layout) {
        viewFile.runLayout(new NewAutoLayoutEngine());
    }
    // Import file
    return new ImportFile(context, editor, viewFile);
}

/**
 * Imports a diagram file, from the file system, into the application.
 * @param context
 *  The application context.
 * @param file
 *  The file to import.
 */
export async function importFileFromFilesystem(
    context: ApplicationStore, editor: DiagramViewEditor
): Promise<AppCommand> {
    const file = await Device.openTextFileDialog(Configuration.file_type_extension);
    if (file) {
        return importExistingFile(context, editor, file.contents as string);
    } else {
        return new DoNothing();
    }
}

/**
 * Imports a STIX file into an existing editor.
 * @param context
 *  The application context.
 * @param editor
 *  The editor to import into.
 * @param file
 *  The file to import.
 * @returns
 *  A command that represents the action.
 */
export async function importExistingStixFile(
    context: ApplicationStore, editor: DiagramViewEditor, file: string
): Promise<AppCommand> {
    const stixBundle = JSON.parse(file) as StixBundle;
    // Construct factory
    const factory = await getObjectFactory(context);
    // Translate STIX
    const jsonFile = new StixToAttackFlowConverter(factory).convert(stixBundle);
    // Construct file
    const viewFile = new DiagramViewFile(factory, jsonFile);
    // Return command
    return new ImportFile(context, editor, viewFile);
}

/**
 * Imports a STIX file, from the file system, into the application.
 * @param context
 *  The application context.
 * @param editor
 *  The editor to import into.
 * @returns
 *  A command that represents the action.
 */
export async function importStixFileFromFilesystem(
    context: ApplicationStore, editor: DiagramViewEditor
) {
    const file = await Device.openTextFileDialog("json");
    if (file) {
        return importExistingStixFile(context, editor, file.contents as string);
    } else {
        return new DoNothing();
    }
}


///////////////////////////////////////////////////////////////////////////////
//  3. Prepare Editor with File  //////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Prepares the editor with an empty file.
 * @param context
 *  The application context.
 * @returns
 *  A command that represents the action.
 */
export async function prepareEditorFromNewFile(
    context: ApplicationStore
): Promise<PrepareEditorWithFile> {
    return new PrepareEditorWithFile(context, await loadNewFile(context));
}

/**
 * Prepares the editor with an existing file.
 * @param context
 *  The application context.
 * @param file
 *  The file export.
 * @param name
 *  The file's name.
 * @returns
 *  A command that represents the action.
 */
export async function prepareEditorFromExistingFile(
    context: ApplicationStore, file: string, name?: string
): Promise<PrepareEditorWithFile> {
    return new PrepareEditorWithFile(context, await loadExistingFile(context, file, name));
}

/**
 * Prepares the editor with an existing file from the file system.
 * @param context
 *  The application context.
 * @returns
 *  A command that represents the action.
 */
export async function prepareEditorFromFileSystem(
    context: ApplicationStore
): Promise<AppCommand> {
    const cmd = await loadFileFromFileSystem(context);
    if (cmd instanceof LoadFile) {
        return new PrepareEditorWithFile(context, cmd);
    } else {
        return cmd;
    }
}

/**
 * Prepares the editor with an existing STIX file.
 * @param context
 *  The application context.
 * @param file
 *  The STIX file.
 * @returns
 *  A command that represents the action.
 */
export async function prepareEditorFromExistingStixFile(
    context: ApplicationStore, file: string
): Promise<PrepareEditorWithFile> {
    return new PrepareEditorWithFile(context, await loadExistingStixFile(context, file));
}

/**
 * Prepares the editor with an existing STIX file from the file system.
 * @param context
 *  The application context.
 * @returns
 *  A command that represents the action.
 */
export async function prepareEditorFromStixFileSystem(
    context: ApplicationStore
): Promise<AppCommand> {
    const cmd = await loadStixFileFromFileSystem(context);
    if (cmd instanceof LoadFile) {
        return new PrepareEditorWithFile(context, cmd);
    } else {
        return cmd;
    }
}

/**
 * Prepares the editor with an existing diagram from the server.
 *
 * If a recovery-bank entry exists for this server id and is newer than the
 * server's `modified` timestamp, prompts the user to restore the local copy
 * or discard it. When restored, the editor is marked dirty-vs-server so the
 * user can re-save the local changes.
 * @param context
 *  The application context.
 * @param id
 *  The server-side diagram id.
 * @param serverModified
 *  The server's last-modified timestamp (unix seconds). When omitted, the
 *  newer-local-copy check is skipped.
 * @returns
 *  A command that represents the action.
 */
export async function prepareEditorFromServerFile(
    context: ApplicationStore, id: string, serverModified?: number
): Promise<PrepareEditorWithFile> {
    const recoveryKey = `server:${id}`;
    const recovery = context.fileRecoveryBank.files.get(recoveryKey);
    if (
        recovery
        && serverModified !== undefined
        && recovery.date.getTime() > serverModified * 1000
    ) {
        const restore = window.confirm(
            "A newer local copy of this diagram exists "
            + `(saved ${recovery.date.toLocaleString()}).\n\n`
            + "OK = Restore the local copy (you'll need to save it).\n"
            + "Cancel = Discard the local copy and load the server version."
        );
        if (restore) {
            const loadCmd = await loadExistingFile(context, recovery.contents, recovery.name);
            const cmd = new PrepareEditorWithFile(context, loadCmd);
            cmd.add(new BindEditorToServer(context, id, true));
            return cmd;
        }
        context.fileRecoveryBank.deleteFile(recoveryKey);
    }
    const cmd = new PrepareEditorWithFile(context, await loadFileFromServer(context, id));
    cmd.add(new BindEditorToServer(context, id));
    return cmd;
}

/**
 * Creates a fresh diagram on the server and prepares the editor with it.
 * The empty file is built client-side and saved back to the server so the
 * stored payload is a valid DiagramViewExport, not just the POST scaffold.
 * @param context
 *  The application context.
 * @returns
 *  A command that represents the action.
 */
export async function prepareEditorFromNewServerFile(
    context: ApplicationStore
): Promise<PrepareEditorWithFile> {
    const id = await createDiagram();
    const loadCmd = await loadNewFile(context);
    const file = loadCmd.editor.file;
    const payload = {
        ...file.toExport(),
        name: file.canvas.properties.toString() || "Untitled Diagram"
    };
    await saveDiagram(id, JSON.stringify(payload, null, 4));
    const cmd = new PrepareEditorWithFile(context, loadCmd);
    cmd.add(new BindEditorToServer(context, id));
    return cmd;
}

/**
 * Prepares the editor with an existing file from a remote url.
 * @param context
 *  The application context.
 * @param url
 *  The remote url.
 * @returns
 *  A command that represents the action.
 */
export async function prepareEditorFromUrl(
    context: ApplicationStore, url: string
): Promise<PrepareEditorWithFile> {
    return new PrepareEditorWithFile(context, await loadFileFromUrl(context, url));
}


///////////////////////////////////////////////////////////////////////////////
//  4. Save / Export Files  ///////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Saves a diagram file to the user's file system.
 * @param context
 *  The application's context.
 * @returns
 *  A command that represents the action.
 */
export function saveActiveFileToDevice(
    context: ApplicationStore
): SaveDiagramFileToDevice {
    return new SaveDiagramFileToDevice(context, context.activeEditor);
}

/**
 * Publishes a diagram file to the user's file system.
 * @param context
 *  The application's context.
 * @returns
 *  A command that represents the action.
 */
export function publishActiveFileToDevice(
    context: ApplicationStore
) {
    return new PublishDiagramFileToDevice(context, context.activeEditor);
}

/**
 * Saves a diagram file to the user's file system.
 * @param context
 *  The application context.
 * @returns
 *  A command that represents the action.
 */
export function saveDiagramImageToDevice(
    context: ApplicationStore
) {
    return new SaveDiagramImageToDevice(context, context.activeEditor);
}

/**
 * Saves a diagram's selection as an image to the user's file system.
 * @param context
 *  The application context.
 * @returns
 *  A command that represents the action.
 */
export function saveSelectionImageToDevice(
    context: ApplicationStore
) {
    return new SaveSelectionImageToDevice(context, context.activeEditor);
}

/**
 * Saves the active diagram file to the server using the binding established
 * when the file was opened or created via the server. Returns a no-op when
 * the active editor has no server binding.
 * @param context
 *  The application context.
 * @returns
 *  A command that represents the action.
 */
export function saveActiveFileToServer(
    context: ApplicationStore
): AppCommand {
    const id = context.serverFileId;
    if (!id) {
        return new DoNothing();
    }
    return new SaveDiagramFileToServer(context.activeEditor, id);
}


///////////////////////////////////////////////////////////////////////////////
//  5. File Recovery Bank  ////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Removes a file from the application's file recovery bank.
 * @param context
 *  The application context.
 * @param id
 *  The file's id.
 * @returns
 *  A command that represents the action.
 */
export function removeFileFromRecoveryBank(
    context: ApplicationStore, id: string
): RemoveFileFromRecoveryBank {
    return new RemoveFileFromRecoveryBank(context, id);
}

/**
 * Clears the application's file recovery bank.
 * @param context
 *  The application context.
 * @returns
 *  A command that represents the action.
 */
export function clearFileRecoveryBank(
    context: ApplicationStore
): ClearFileRecoveryBank {
    return new ClearFileRecoveryBank(context);
}
