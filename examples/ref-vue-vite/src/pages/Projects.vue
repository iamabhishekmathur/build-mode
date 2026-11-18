<script setup lang="ts">
import { ref } from 'vue';
import { useFlag, Variant } from '@stagecraft/vue';
import { PROJECTS_API, send, useApi, type Project } from '../api';
import { useSession } from '../stores/session';

const session = useSession();
const { data: projects, error, reload } = useApi<Project[]>(`${PROJECTS_API}/v1/projects`);
const showHealth = useFlag('project-health', false);
const name = ref('');
const createError = ref<string | null>(null);

async function create() {
  createError.value = null;
  try {
    await send('POST', `${PROJECTS_API}/v1/projects`, { name: name.value });
    name.value = '';
    await reload();
  } catch (e) {
    createError.value = (e as Error).message;
  }
}
</script>

<template>
  <h1>Projects</h1>
  <p v-if="error" class="error" data-testid="projects-error">Could not load projects: {{ error }}</p>
  <p v-else-if="!projects" class="muted">Loading projects…</p>
  <section v-else-if="projects.length === 0" class="card empty" data-testid="projects-empty">
    <h2>No projects yet</h2>
    <p>Create a project to plan work with your team.</p>
  </section>
  <Variant v-else name="project-list-layout">
    <template #list>
      <ul class="list" data-testid="projects-list">
        <li v-for="p in projects" :key="p.id">
          <span>{{ p.name }}</span>
          <span class="muted">{{ p.lead }} · due {{ p.due }}</span>
          <span v-if="showHealth" :class="`pill pill--${p.health}`">{{ p.health.replace('_', ' ') }}</span>
        </li>
      </ul>
    </template>
    <template #grid>
      <div class="cards" data-testid="projects-grid">
        <article v-for="p in projects" :key="p.id" class="card">
          <h3>{{ p.name }}</h3>
          <p class="muted">{{ p.lead }} · due {{ p.due }}</p>
          <span v-if="showHealth" :class="`pill pill--${p.health}`">{{ p.health.replace('_', ' ') }}</span>
        </article>
      </div>
    </template>
  </Variant>
  <form v-if="session.me?.role === 'owner'" class="card form" @submit.prevent="create">
    <label>New project <input v-model="name" placeholder="Project name" /></label>
    <button class="btn" type="submit">Create project</button>
    <p v-if="createError" class="error">{{ createError }}</p>
  </form>
</template>
