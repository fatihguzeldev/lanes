import { useEffect, useState } from 'react';
import { accountToday } from '../../model/planning';
/** A local clock tick updates day boundaries; it performs no provider or server polling. */
export function usePlanningToday(zone: string, clockOffset: number): string {
  const read = () => accountToday(zone, new Date(Date.now() + clockOffset).toISOString());
  const [today, setToday] = useState(read);
  useEffect(() => {
    const update = () =>
      setToday(accountToday(zone, new Date(Date.now() + clockOffset).toISOString()));
    update();
    const timer = setInterval(update, 60_000);
    document.addEventListener('visibilitychange', update);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, [zone, clockOffset]);
  return today;
}
