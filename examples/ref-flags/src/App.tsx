import { useBooleanFlagValue } from '@openfeature/react-sdk';
import { gb, ld3, ld4, unleash, useFlagsVersion } from './flags';

function Card({ title, sdk, children }: { title: string; sdk: string; children: React.ReactNode }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      <p className="sdk">{sdk}</p>
      {children}
    </section>
  );
}

function Checkout() {
  const fresh = useBooleanFlagValue('of-new-checkout', false);
  return <p data-testid="of-checkout">{fresh ? 'New one-page checkout' : 'Classic three-step checkout'}</p>;
}

const BANNERS: Record<string, string> = { none: 'No promotion', sale: 'Spring sale: 20% off', holiday: 'Happy holidays: free shipping' };

export function App() {
  useFlagsVersion();
  const banner = ld3.variation('ld-banner', 'none') as string;
  const compact = ld4.boolVariation('ld4-compact-header', false);
  const annual = gb.isOn('gb-annual-pricing');
  const beta = unleash.isEnabled('unleash-beta-badge');
  return (
    <main>
      <h1 className={compact ? 'compact' : ''}>Flagship</h1>
      <div className="grid">
        <Card title="Checkout" sdk="OpenFeature (@openfeature/react-sdk)">
          <Checkout />
        </Card>
        <Card title="Promotion" sdk="LaunchDarkly (launchdarkly-js-client-sdk v3)">
          <p data-testid="ld-banner">{BANNERS[banner] ?? banner}</p>
        </Card>
        <Card title="Header" sdk="LaunchDarkly (@launchdarkly/js-client-sdk v4)">
          <p data-testid="ld4-header">{compact ? 'Compact header' : 'Tall header'}</p>
        </Card>
        <Card title="Pricing" sdk="GrowthBook (@growthbook/growthbook)">
          <p data-testid="gb-pricing">{annual ? 'Billed annually: $96/yr' : 'Billed monthly: $10/mo'}</p>
        </Card>
        <Card title="Beta" sdk="Unleash (unleash-proxy-client)">
          <p data-testid="unleash-beta">{beta ? 'Beta features on' : 'Beta features off'}</p>
        </Card>
      </div>
    </main>
  );
}
