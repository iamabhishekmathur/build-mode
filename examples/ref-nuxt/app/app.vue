<script setup lang="ts">
import { StagecraftRoot } from '@stagecraft/vue';
import { API, type Me } from '~/lib/api';

// Fetched on the server during SSR, then on the client after navigation or a refresh.
const { data: me } = await useFetch<Me>(`${API}/v1/me`, { key: 'me' });
// Server data lives in useFetch / useAsyncData: re-fetch all of it when the prototype state changes.
const refresh = () => refreshNuxtData();
</script>

<template>
  <div>
    <nav class="nav">
      <strong>Orbit Support</strong>
      <NuxtLink to="/">Tickets</NuxtLink>
      <NuxtLink to="/settings">Settings</NuxtLink>
      <span class="spacer" />
      <span data-testid="me">{{ me ? `${me.name} · ${me.role}` : '…' }}</span>
    </nav>
    <main class="main">
      <StagecraftRoot ssr :remount="false" @data-change="refresh">
        <NuxtPage />
      </StagecraftRoot>
    </main>
  </div>
</template>
