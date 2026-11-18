<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { RouterLink, RouterView } from 'vue-router';
import { StagecraftRoot } from '@stagecraft/vue';
import { useSession } from './stores/session';

const session = useSession();
onMounted(() => session.load());

const BANNERS: Record<string, { tone: string; text: string } | undefined> = {
  trial_expired: { tone: 'warning', text: 'Your free trial has ended. Add billing details to keep editing projects.' },
  read_only: { tone: 'danger', text: 'This workspace is read-only. An admin locked it.' },
};
const banner = computed(() => (session.workspace ? BANNERS[session.workspace.status] : undefined));
</script>

<template>
  <div class="shell">
    <nav class="nav" aria-label="Main">
      <span class="brand">Fieldnote</span>
      <RouterLink to="/">Home</RouterLink>
      <RouterLink to="/projects">Projects</RouterLink>
      <RouterLink to="/settings">Settings</RouterLink>
      <span class="spacer" />
      <span class="me" data-testid="me">{{ session.me ? `${session.me.name} · ${session.me.role}` : '…' }}</span>
    </nav>
    <main class="main">
      <!-- Pinia stores live outside the remounted tree: reload them on Stagecraft state changes. -->
      <StagecraftRoot @data-change="session.load()">
        <div v-if="banner" role="status" :class="`banner banner--${banner.tone}`" data-testid="workspace-banner">{{ banner.text }}</div>
        <RouterView />
      </StagecraftRoot>
    </main>
  </div>
</template>
