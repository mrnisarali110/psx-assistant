// Placeholder from the foundation task; Task K (stock page) replaces this file.
import type { ScreenProps } from '../App.tsx';

export function Stock({ symbol }: ScreenProps & { symbol: string }) {
  return <main className="p-4"><h1 className="text-20 font-bold">{symbol}</h1></main>;
}
