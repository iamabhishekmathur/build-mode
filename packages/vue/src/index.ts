import { computed, defineComponent, Fragment, h, onMounted, onUnmounted, readonly, ref, type App, type ComputedRef, type PropType, type Ref } from 'vue';
import type { StagecraftRuntime } from '@stagecraft/runtime';

/**
 * Vue 3 adapter for Stagecraft (Vue + Vite, Nuxt).
 *
 * Every export is a no-op when `window.__STAGECRAFT__` is absent (production, SSR, tests),
 * so product code that uses `<Variant>` or `useFlag` ships safely. Mock code never
 * lives here: it lives in `stagecraft/` and is loaded by the dev proxy only.
 *
 * Plain render functions (no .vue files), so the package needs no compiler step.
 */

function runtime(): StagecraftRuntime | undefined {
  return typeof window === 'undefined' ? undefined : window.__STAGECRAFT__;
}

// One reactive version per kind of change, shared by every composable. The runtime is a
// page-wide singleton, so one subscription for the page's lifetime is enough.
const uiVersion = ref(0);
const dbVersion = ref(0);
/** True while a server-rendered app hydrates: composables return the server's values (fallbacks) until then. */
const hydrating = ref(false);
let subscribed = false;

function subscribe(rt: StagecraftRuntime) {
  if (subscribed) return;
  subscribed = true;
  rt.on('ui', () => uiVersion.value++);
  rt.on('data', () => uiVersion.value++);
  rt.on('db', () => dbVersion.value++);
}

/** The runtime, read reactively: computeds that call this re-run on flag, variant and state changes. */
function tracked(): StagecraftRuntime | undefined {
  const rt = runtime();
  if (!rt) return undefined;
  subscribe(rt);
  void uiVersion.value;
  return hydrating.value ? undefined : rt;
}

/**
 * Wrap the app (inside your router view's parent). On persona, state or scenario changes it
 * remounts its children so data refetches. Without it, Stagecraft falls back to a full page reload.
 *
 * - `onDataChange` (or `@data-change`): also called on those changes. Nuxt: `refreshNuxtData`.
 *   Pinia stores live outside the component tree: reload them here, or load them in `onMounted`.
 * - `remount` (default true): set false when `onDataChange` already reloads everything.
 * - `ssr`: set it for server-rendered apps (Nuxt). Flags and variants then render their defaults
 *   during hydration, like the server did, and switch right after. No hydration mismatch.
 *
 * <StagecraftRoot><RouterView /></StagecraftRoot>
 */
export const StagecraftRoot = defineComponent({
  name: 'StagecraftRoot',
  props: {
    onDataChange: Function as PropType<() => unknown>,
    remount: { type: Boolean, default: true },
    ssr: { type: Boolean, default: false },
  },
  setup(props, { slots }) {
    const rt = runtime();
    const dataVersion = ref(rt?.info.dataVersion ?? 0);
    if (rt && props.ssr) hydrating.value = true;
    let off: (() => void) | undefined;
    onMounted(() => {
      if (!rt) return;
      subscribe(rt);
      hydrating.value = false;
      rt.registerAdapter('vue');
      off = rt.on('data', (info) => {
        props.onDataChange?.();
        if (props.remount) dataVersion.value = info.dataVersion;
      });
    });
    onUnmounted(() => off?.());
    return () => h(Fragment, { key: dataVersion.value }, slots.default?.());
  },
});

/** Value of a feature flag. Returns `fallback` outside Stagecraft. */
export function useFlag<T>(key: string, fallback: T): ComputedRef<T> {
  return computed(() => {
    const rt = tracked();
    return rt ? (rt.flag(key, fallback as any) as T) : fallback;
  });
}

/** Selected option of a variant. Outside Stagecraft this is `fallback` or the first option. */
export function useVariant<const O extends string>(name: string, options: readonly O[], fallback?: O): ComputedRef<O> {
  const opts = [...options];
  return computed(() => {
    const rt = tracked();
    return (rt ? rt.variant(name, opts, fallback) : (fallback ?? opts[0])) as O;
  });
}

const slotNames = (slots: Record<string, unknown>) => Object.keys(slots).filter((k) => k !== 'default' && !k.startsWith('_'));

/**
 * Render one of several design options, one named slot per option. Removed at handoff:
 * keep the winner, delete the wrapper.
 *
 * <Variant name="agent-list">
 *   <template #table><AgentTable /></template>
 *   <template #cards><AgentCards /></template>
 * </Variant>
 *
 * The options are the slot names, in order. Pass `:options` to fix them explicitly.
 */
export const Variant = defineComponent({
  name: 'Variant',
  props: {
    name: { type: String, required: true },
    options: Array as PropType<string[]>,
    fallback: String,
  },
  setup(props, { slots }) {
    return () => {
      const opts = props.options ?? slotNames(slots);
      const rt = tracked();
      const pick = rt && opts.length ? rt.variant(props.name, opts, props.fallback) : (props.fallback ?? opts[0]);
      const slot = pick ? slots[pick] : undefined;
      return slot ? slot() : slots.default?.();
    };
  },
});

/**
 * Bumps when the mock DB changes (a tape step, another tab, an agent seed).
 * Watch it in your data loaders to refetch without a remount.
 */
export function useMockDbVersion(): Readonly<Ref<number>> {
  const rt = runtime();
  if (rt) subscribe(rt);
  return readonly(dbVersion);
}

/** Current persona id, or undefined outside Stagecraft. */
export function usePersona(): ComputedRef<string | undefined> {
  return computed(() => tracked()?.info.state.persona);
}

export const isStagecraft = () => !!runtime();

/** Optional: `app.use(Stagecraft)` registers `<StagecraftRoot>` and `<Variant>` globally. */
export const Stagecraft = {
  install(app: App) {
    app.component('StagecraftRoot', StagecraftRoot);
    app.component('Variant', Variant);
  },
};
