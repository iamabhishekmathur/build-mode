<script setup lang="ts">
import { ref, watchEffect } from 'vue';
import { useSession } from '../stores/session';

const session = useSession();
const draft = ref('');
const saved = ref(false);
const saveError = ref<string | null>(null);
watchEffect(() => {
  draft.value = session.me?.statusMessage ?? '';
});

async function save() {
  saved.value = false;
  saveError.value = null;
  try {
    await session.setStatus(draft.value);
    saved.value = true;
  } catch (e) {
    saveError.value = (e as Error).message;
  }
}
</script>

<template>
  <h1>Settings</h1>
  <p v-if="!session.me" class="muted">Loading…</p>
  <form v-else class="card form" @submit.prevent="save">
    <p class="muted">Signed in as {{ session.me.email }}</p>
    <label>Status message <input v-model="draft" name="status" maxlength="80" placeholder="What are you working on?" /></label>
    <button class="btn" type="submit">Save status</button>
    <p v-if="saved" class="muted" role="status">Saved.</p>
    <p v-if="saveError" class="error" data-testid="save-error">{{ saveError }}</p>
    <p data-testid="current-status">{{ session.me.statusMessage || 'No status set.' }}</p>
  </form>
</template>
