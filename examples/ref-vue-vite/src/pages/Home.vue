<script setup lang="ts">
import { useSession } from '../stores/session';

const session = useSession();
</script>

<template>
  <p v-if="session.error" class="error">Could not load your workspace: {{ session.error }}</p>
  <p v-else-if="!session.workspace" class="muted">Loading…</p>
  <template v-else>
    <h1 data-testid="workspace-name">{{ session.workspace.name }}</h1>
    <section class="card">
      <h2>Plan</h2>
      <p data-testid="plan">{{ session.workspace.plan }} plan · {{ session.workspace.seats }} seats</p>
    </section>
    <section v-if="session.me?.statusMessage" class="card">
      <h2>Your status</h2>
      <p data-testid="home-status">{{ session.me.statusMessage }}</p>
    </section>
  </template>
</template>
