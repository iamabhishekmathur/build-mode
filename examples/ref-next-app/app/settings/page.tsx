import { get, type Account, type Me } from '../../lib/api';

export const dynamic = 'force-dynamic';

export default async function Settings() {
  const [me, account] = await Promise.all([get<Me>('/v1/me'), get<Account>('/v1/account')]);
  return (
    <>
      <h1>Settings</h1>
      <p data-testid="settings-role">{me.role === 'owner' ? `You can change billing for ${account.name}.` : 'Only the account owner can change billing.'}</p>
    </>
  );
}
