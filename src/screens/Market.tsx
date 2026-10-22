import type { ScreenProps } from '../App.tsx';
import { MarketDetails } from '../components/MarketMood.tsx';

/** Market (a bottom tab): the Market Compass (value, shares vs safe yield, trend), rates and inflation, and where spare cash could go. */
export function Market({ data }: ScreenProps) {
  return (
    <>
      <header>
        <h1 className="text-20 font-bold tracking-tight lg:text-28">Market</h1>
        <p className="text-14 text-muted">What the market says about extra money, and why</p>
      </header>
      <MarketDetails data={data} />
    </>
  );
}
