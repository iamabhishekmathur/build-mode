<script setup lang="ts">
import { API, type Account, type Me } from '~/lib/api';

// useAsyncData + $fetch (ofetch) instead of useFetch: the same server-side path, written another way.
const { data } = await useAsyncData('settings', () => Promise.all([$fetch<Me>(`${API}/v1/me`), $fetch<Account>(`${API}/v1/account`)]));
const text = computed(() => {
  if (!data.value) return '';
  const [me, account] = data.value;
  return me.role === 'admin' ? `You can change the plan for ${account.name}.` : 'Only admins can change the plan.';
});
</script>

<template>
  <div>
    <h1>Settings</h1>
    <p data-testid="settings-role">{{ text }}</p>
  </div>
</template>
