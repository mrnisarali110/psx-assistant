import type { ScreenProps } from '../App.tsx';
import { MarketDetails } from '../components/MarketMood.tsx';
import { Icon } from '../components/Icon.tsx';
import { Button } from '../components/ui.tsx';

/** Market: bull market ON/OFF, the State Bank policy rate, and where spare cash could go. Opened from Home's market card. */
export function Market({ data, go }: ScreenProps) {
  return (
    <>
      <header className="flex items-center gap-2">
        <Button kind="ghost" label="Back to Home" className="-ml-2 lg:hidden" onClick={() => go('home')}><Icon name="chevron" className="h-5 w-5 rotate-180" /></Button>
        <div>
          <h1 className="text-xl font-bold tracking-tight">Market</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">Bull market ON/OFF, the State Bank policy rate, and where spare cash could go</p>
        </div>
      </header>
      <MarketDetails data={data} />
    </>
  );
}
