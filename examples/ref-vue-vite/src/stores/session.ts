import { defineStore } from 'pinia';
import { send, type User, type Workspace } from '../api';

/** Who is signed in, and their workspace. Loaded once at start and after Stagecraft state changes. */
export const useSession = defineStore('session', {
  state: () => ({ me: null as User | null, workspace: null as Workspace | null, error: null as string | null }),
  actions: {
    async load() {
      try {
        const [me, workspace] = await Promise.all([send<User>('GET', '/api/me'), send<Workspace>('GET', '/api/workspace')]);
        this.me = me;
        this.workspace = workspace;
        this.error = null;
      } catch (e) {
        this.error = (e as Error).message;
      }
    },
    async setStatus(statusMessage: string) {
      this.me = await send<User>('PATCH', '/api/me', { statusMessage });
    },
  },
});
