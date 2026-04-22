<template>
  <AppHotkeyBox
    id="main"
    :class="applicationMode"
  >
    <AppTitleBar
      id="app-title-bar"
      v-if="!application.readOnlyMode"
    />
    <FindDialog
      id="find-dialog"
      v-if="extendedEditorShown"
      :style="findDialogLayout"
    />
    <div
      id="app-body"
      ref="body"
      :style="gridLayout"
    >
      <div class="frame center">
        <BlockDiagram id="block-diagram" />
        <SplashMenu
          id="splash-menu"
          v-if="splashMenuShown"
        />
      </div>
      <div
        class="frame right"
        v-if="extendedEditorShown"
      >
        <div
          class="resize-handle"
          @pointerdown="startResize($event, Handle.Right)"
        />
        <EditorSidebar id="app-sidebar" />
      </div>
      <div
        class="frame bottom"
        v-if="extendedEditorShown"
      >
        <AppFooterBar id="app-footer-bar" />
      </div>
    </div>
  </AppHotkeyBox>
</template>

<script lang="ts">
// Dependencies
import * as AppCommand from "./assets/scripts/Application/Commands";
import { useApplicationStore } from './stores/ApplicationStore';
import { defineComponent, markRaw, ref } from 'vue';
import { Device, clamp, OperatingSystem, PointerTracker } from "./assets/scripts/Browser";
import type { Command } from "./assets/scripts/Application"
import { DfdSocketClient } from "./assets/scripts/api/DfdSocketClient";
import { wireSocketClient } from "./assets/scripts/api/DfdSocketDispatcher";
import { useEditorEditEvent } from "@/composables/useEditorEditEvent";
// Components
import FindDialog from "@/components/Elements/FindDialog.vue";
import SplashMenu from "@/components/Elements/SplashMenu.vue";
import AppTitleBar from "@/components/Elements/AppTitleBar.vue";
import AppHotkeyBox from "@/components/Elements/AppHotkeyBox.vue";
import BlockDiagram from "@/components/Elements/BlockDiagram.vue";
import AppFooterBar from "@/components/Elements/AppFooterBar.vue";
import EditorSidebar from "@/components/Elements/EditorSidebar.vue";

const Handle = {
  None   : 0,
  Right  : 1
}

export default defineComponent({
  name: 'App',
  setup() {
    const application = useApplicationStore();
    useEditorEditEvent(application, () => {
      if (
        application.remoteActivityUndoDepth !== null &&
        application.activeEditor.undoDepth !== application.remoteActivityUndoDepth
      ) {
        application.clearRemoteActivity();
      }
    });
    return { body: ref<HTMLElement | null>(null) };
  },
  data() {
    return {
      application: useApplicationStore(),
      Handle,
      bodyWidth: -1,
      bodyHeight: -1,
      frameSize: {
        [Handle.Right]: 376
      },
      minFrameSize: {
        [Handle.Right]: 310
      },
      track: markRaw(new PointerTracker()),
      onResizeObserver: null as ResizeObserver | null,
      disposeSocket: null as (() => void) | null
    }
  },
  computed: {

    /**
     * Returns the application's current mode.
     */
    applicationMode() {
        const classes = [];
        if(this.application.isShowingSplash) {
          classes.push("landing");
        }
        if(this.application.readOnlyMode) {
          classes.push("readonly")
        }
        return classes;
    },

    /**
     * Returns whether the extended editor is shown.
     * @returns
     *  True if the extended editor should be shown, false otherwise.
     */
    extendedEditorShown() {
      return !(this.application.isShowingSplash || this.application.readOnlyMode)
    },

    /**
     * Returns whether the splash menu can be shown.
     * @returns
     *  True if the splash menu should be shown, false otherwise.
     */
    splashMenuShown(): boolean {
      return this.application.isShowingSplash && !this.application.readOnlyMode;
    },

    /**
     * Returns the grid layout, for use after the splash screen.
     * @returns
     *  The current grid layout.
     */
    gridLayout(): { gridTemplateColumns: string, gridTemplateRows?: string } {
      const r = this.frameSize[Handle.Right];
      if(this.application.isShowingSplash || this.application.readOnlyMode) {
        return {
          gridTemplateColumns: "100%",
          gridTemplateRows: "100%"
        }
      } else {
        return {
          gridTemplateColumns: `minmax(0, 1fr) ${ r }px`
        }
      }
    },

    /**
     * Compute the location of the find dialog
     * @returns
     *  The current grid layout.
     */
    findDialogLayout(): { right: string } {
      const r = this.frameSize[Handle.Right] + 25;
      return {
        right: `${r}px`
      }
    }

  },
  methods: {

    /**
     * Executes an application command.
     * @param command
     *  The command to execute.
     */
    execute: async function execute(command: Command) {
      await this.application.execute(command);
    },

    /**
     * Resize handle drag start behavior.
     * @param event
     *  The pointer event.
     * @param handle
     *  The id of the handle being dragged.
     */
    startResize(event: PointerEvent, handle: number) {
      const origin = this.frameSize[handle];
      this.track.capture(event, (e, track) => {
        e.preventDefault();
        switch (handle) {
          default:
          case Handle.None:
            break;
          case Handle.Right:
            this.setRightFrameSize(origin - track.deltaX);
            break;
        }
      });
    },

    /**
     * Sets the size of the right frame.
     * @param size
     *  The new size of the right frame.
     */
    setRightFrameSize(size: number) {
      const max = this.bodyWidth;
      const min = this.minFrameSize[Handle.Right];
      this.frameSize[Handle.Right] = clamp(size, min, max);
    }

  },
  async created() {
    const ctx = this.application;

    // Connect to the Flask WebSocket endpoint and register broadcast handlers.
    // The connection is non-fatal: if Flask isn't running, the client will
    // retry in the background without blocking any app functionality.
    //
    // Ordering: the socket is opened before settings are fetched below so the
    // remote-control lifecycle envelope (agent-attached) can be received
    // during app startup. Broadcasts that arrive before settings load are
    // dispatched to handlers that read the Pinia store — the store is
    // populated with defaults at its `defineStore` call (see
    // src/stores/ApplicationStore.ts), so dispatch against partially-
    // configured state is safe even if tight. Settings affect theme and
    // display flags, not dispatch correctness.
    //
    // URL resolution order:
    //   1. `VITE_WS_URL` (build-time override, e.g. for production / LAN dev)
    //   2. derived from `window.location` + hardcoded `:5050/ws` (dev default)
    //
    // The derived default assumes Flask runs on port 5050 on the same host
    // as the Vite dev server (see server/CLAUDE.md "Port 5050"). When the app
    // is ever served from the same origin as the WS endpoint, set
    // `VITE_WS_URL=ws://<host>/ws` so the port is dropped.
    const envWsUrl = import.meta.env.VITE_WS_URL as string | undefined;
    let wsUrl: string;
    if (envWsUrl) {
      wsUrl = envWsUrl;
    } else {
      const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsHost = window.location.hostname || "localhost";
      wsUrl = `${wsProtocol}//${wsHost}:5050/ws`;
    }
    this.disposeSocket = wireSocketClient(new DfdSocketClient(wsUrl), ctx);

    // Import settings
    const os = Device.getOperatingSystemClass();
    let settings;
    if(os === OperatingSystem.MacOS) {
      settings = await (await fetch("./settings_macos.json")).json();
    } else {
      settings = await (await fetch("./settings_win.json")).json();
    }
    
    // Load settings
    this.execute(AppCommand.loadSettings(ctx, settings));
    
    // Process query parameters
    const params = new URLSearchParams(window.location.search);
    
    // Set default theme
    const theme = params.get("theme");
    if(theme) {
      this.execute(AppCommand.setDefaultTheme(ctx, theme));
    }

    // Load file
    const src = params.get("src");
    if(src) {
      // Set readonly mode. (Only applies when `src` parameter is also provided).
      if (params.has("readonly")) {
        this.execute(AppCommand.setReadonlyMode(ctx, true));
      }
      // Try to load a file from a URL.
      try {
        // TODO: Incorporate loading dialog
        this.execute(await AppCommand.prepareEditorFromUrl(ctx, src));
      } catch(ex) {
        console.error(`Failed to load file from url: '${ src }'`);
        console.error(ex);
      }
    }
  },
  mounted() {
    this.bodyWidth = this.body!.clientWidth;
    this.bodyHeight = this.body!.clientHeight;
    this.onResizeObserver = new ResizeObserver(() => {
      // Update current body size
      this.bodyWidth = this.body!.clientWidth;
      this.bodyHeight = this.body!.clientHeight;
      // Restrict bottom and right frames
      this.setRightFrameSize(this.frameSize[Handle.Right]);
    });
    this.onResizeObserver.observe(this.body!);

  },
  unmounted() {
    this.onResizeObserver?.disconnect();
    this.disposeSocket?.();
  },
  components: {
    AppHotkeyBox,
    AppTitleBar,
    BlockDiagram,
    AppFooterBar,
    EditorSidebar,
    FindDialog,
    SplashMenu
  },
});
</script>

<style>

/** === Global === */

html,
body {
  width: 100%;
  height: 100%;
  font-family: "Inter", sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  padding: 0px;
  margin: 0px;
  background: #1a1a1a;
  overflow: hidden;
}

a {
  color: inherit;
  text-decoration: none;
}

p {
  margin: 0px;
}

ul {
  margin: 0px;
  padding: 0px;
}

/** === Main App === */

#app {
  width: 100%;
  height: 100%;
}

#main {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
}

#app-title-bar {
  flex-shrink: 0;
  height: 31px;
  color: #9e9e9e;
  background: #262626;
}

#app-body {
  flex: 1;
  display: grid;
  overflow: hidden;
  grid-template-rows: minmax(0, 1fr) 27px;
}

#block-diagram {
  width: 100%;
  height: 100%;
  border-top: solid 1px #333333;
  box-sizing: border-box;
}

#splash-menu {
  position: absolute;
}

#app-sidebar {
  width: 100%;
  height: 100%;
}

#app-footer-bar {
  color: #bfbfbf;
  width: 100%;
  height: 100%;
  border-top: solid 1px #333333;
  background: #262626;
}

.readonly #block-diagram {
  border-top: none;
}

/** === Frames === */

.frame {
  position: relative;
}

.frame.center {
  display: flex;
  align-items: center;
  justify-content: center;
}

.frame.bottom {
  grid-column: 1 / 3;
}

/** === Resize Handles === */

.resize-handle {
  position: absolute;
  display: block;
  background: #726de2;
  transition: 0.15s opacity;
  opacity: 0;
  z-index: 1;
}
.resize-handle:hover {
  transition-delay: 0.2s;
  opacity: 1;
}

.frame.right .resize-handle {
  top: 0px;
  left: -2px;
  width: 4px;
  height: 100%;
  cursor: e-resize;
}

</style>
