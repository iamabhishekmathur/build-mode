<script setup lang="ts">
import { useFlag, Variant } from '@stagecraft/vue';
import { API, type Account, type Me, type Ticket } from '~/lib/api';

const [{ data: account }, { data: tickets }, { data: me }] = await Promise.all([
  useFetch<Account>(`${API}/v1/account`, { key: 'account' }),
  useFetch<Ticket[]>(`${API}/v1/tickets`, { key: 'tickets' }),
  useFetch<Me>(`${API}/v1/me`, { key: 'me' }),
]);
const showPriority = useFlag('priority-badges', false);

const BANNER: Record<string, string | undefined> = {
  past_due: 'Your last invoice is past due. Update billing to keep receiving tickets.',
  suspended: 'This account is suspended. Customers cannot open new tickets.',
};
const banner = computed(() => (account.value ? BANNER[account.value.status] : undefined));
const canClose = computed(() => account.value?.status !== 'suspended');

/** A client-side write: the browser calls the API, then the server data refreshes. */
async function close(id: string) {
  await $fetch(`${API}/v1/tickets/${id}/close`, { method: 'POST' });
  await refreshNuxtData('tickets');
}
</script>

<template>
  <div>
    <h1 data-testid="account-name">{{ account?.name }}</h1>
    <p class="muted" data-testid="plan">{{ account?.plan }} plan · {{ account?.seats }} seats</p>
    <div v-if="banner" role="status" :class="`banner banner--${account?.status}`" data-testid="banner">{{ banner }}</div>
    <h2>Tickets</h2>
    <p v-if="!tickets?.length" data-testid="empty">No tickets. Your customers are happy.</p>
    <Variant v-else name="ticket-list-layout">
      <template #table>
        <table class="table" data-testid="tickets">
          <tbody>
            <tr v-for="t in tickets" :key="t.id">
              <td>{{ t.subject }}</td>
              <td class="muted">{{ t.customer }}</td>
              <td v-if="showPriority"><span :class="`pill pill--${t.priority}`">{{ t.priority }}</span></td>
              <td :class="`status status--${t.status}`">{{ t.status }}</td>
              <td>
                <button v-if="t.status === 'open' && canClose" class="btn" @click="close(t.id)">Close</button>
              </td>
            </tr>
          </tbody>
        </table>
      </template>
      <template #cards>
        <div class="cards" data-testid="ticket-cards">
          <article v-for="t in tickets" :key="t.id" class="card">
            <h3>{{ t.subject }}</h3>
            <p class="muted">{{ t.customer }} · {{ t.status }}</p>
            <span v-if="showPriority" :class="`pill pill--${t.priority}`">{{ t.priority }}</span>
          </article>
        </div>
      </template>
    </Variant>
    <p class="muted">Signed in as {{ me?.name }}.</p>
  </div>
</template>
