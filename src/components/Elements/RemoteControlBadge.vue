<template>
  <div
    class="remote-control-badge"
    v-if="application.isRemotelyActive"
  >
    <span class="dot">●</span>
    <span class="label">Editor is controlled remotely</span>
  </div>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import { useApplicationStore } from "@/stores/ApplicationStore";

export default defineComponent({
  name: "RemoteControlBadge",
  data() {
    return { application: useApplicationStore() };
  }
});
</script>

<style scoped>

.remote-control-badge {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #ff4d4d;
  font-size: 9.5pt;
  font-weight: 600;
  user-select: none;
  pointer-events: none;
  animation: blink 1s step-start infinite;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0; }
}

</style>
