import {
    HideSearchMenu,
    HideSplashMenu,
    OpenHyperlink,
    RunSearch,
    SetReadonlyMode,
    SetRemoteControlLocked,
    ShowSearchMenu,
    ShowSplashMenu,
    SwitchToFullscreen,
    ToNextSearchResult,
    ToPreviousSearchResult
} from "./index.commands";
import type { OpenChartFinder } from "@/assets/scripts/OpenChartFinder";
import type { ApplicationStore } from "@/stores/ApplicationStore";
import type { DiagramViewEditor } from "@OpenChart/DiagramEditor";


///////////////////////////////////////////////////////////////////////////////
//  1. Search  ////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Display the search menu.
 * @param ctx
 *  The application context.
 * @returns
 *  A command that represents the action.
 */
export function showSearchMenu(ctx: ApplicationStore): ShowSplashMenu {
    return new ShowSearchMenu(ctx);
}

/**
 * Hide the search menu.
 * @param ctx
 *  The application context.
 * @returns
 *  A command that represents the action.
 */
export function hideSearchMenu(ctx: ApplicationStore): HideSplashMenu {
    return new HideSearchMenu(ctx);
}

/**
 * Runs a search on an editor.
 * @param finder
 *  The finder to operate on.
 * @param editor
 *  The editor to search.
 * @param query
 *  The search query.
 * @returns
 *  A command that represents the action.
 */
export function runSearch(
    finder: OpenChartFinder, editor: DiagramViewEditor, query: string
) {
    return new RunSearch(finder, editor, query);
}

/**
 * Advances the finder to the next search result.
 * @param finder
 *  The finder to operate on.
 * @returns
 *  A command that represents the action.
 */
export function toNextSearchResult(
    finder: OpenChartFinder
) {
    return new ToNextSearchResult(finder);
}


/**
 * Advances the finder to the previous search result.
 * @param finder
 *  The finder to operate on.
 * @returns
 *  A command that represents the action.
 */
export function toPreviousSearchResult(
    finder: OpenChartFinder
) {
    return new ToPreviousSearchResult(finder);
}


///////////////////////////////////////////////////////////////////////////////
//  2. Splash Menu  ///////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Display the splash menu.
 * @param ctx
 *  The application context.
 * @returns
 *  A command that represents the action.
 */
export function showSplashMenu(
    ctx: ApplicationStore
): ShowSplashMenu {
    return new ShowSplashMenu(ctx);
}

/**
 * Hide the splash menu.
 * @param ctx
 *  The application context.
 * @returns
 *  A command that represents the action.
 */
export function hideSplashMenu(
    ctx: ApplicationStore
): HideSplashMenu {
    return new HideSplashMenu(ctx);
}


///////////////////////////////////////////////////////////////////////////////
//  3. Miscellaneous  /////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


/**
 * Opens an external hyperlink.
 * @param url
 *  The hyperlink's url.
 * @returns
 *  A command that represents the action.
 */
export function openHyperlink(url: string): OpenHyperlink {
    return new OpenHyperlink(url);
}

/**
 * Switches the application to fullscreen mode.
 * @returns
 *  A command that represents the action.
 */
export function switchToFullscreen(): SwitchToFullscreen {
    return new SwitchToFullscreen();
}

/**
 * Sets the application to readonly mode.
 * @remarks
 *  When a live editor is active, changing the flag also installs or
 *  uninstalls the interactive-editing plugins ({@link RectangleSelectPlugin}
 *  and {@link PowerEditPlugin}) on the editor's interface so the change
 *  takes effect immediately. No-op on the {@link PhantomEditor} placeholder.
 * @param context
 *  The application context.
 * @param value
 *  The read-only state to apply.
 * @returns
 *  A command that represents the action.
 */
export function setReadonlyMode(
    context: ApplicationStore, value: boolean
): SetReadonlyMode {
    return new SetReadonlyMode(context, value);
}

/**
 * Locks or unlocks the editor for remote-control sessions.
 * @remarks
 *  Installs/uninstalls interactive-editing plugins without touching
 *  `readOnlyMode`, so the application chrome remains visible during agent
 *  control.
 * @param context
 *  The application context.
 * @param value
 *  True to lock (remove edit plugins), false to unlock.
 * @returns
 *  A command that represents the action.
 */
export function setRemoteControlLocked(
    context: ApplicationStore, value: boolean
): SetRemoteControlLocked {
    return new SetRemoteControlLocked(context, value);
}
