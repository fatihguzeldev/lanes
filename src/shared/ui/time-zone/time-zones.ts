import type { Choice } from '../select/selection';

const supported = Intl.supportedValuesOf('timeZone');

function valid(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone }).format();
    return true;
  } catch {
    return false;
  }
}

export function timeZoneChoices(current: string): Choice[] {
  const zones = new Set(['UTC', ...supported]);
  if (valid(current)) zones.add(current);
  return [...zones].sort().map((value) => ({ value, label: value.replaceAll('_', ' ') }));
}

export function timeZoneLabel(zone: string): string {
  try {
    const offset = new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'shortOffset' })
      .formatToParts()
      .find((part) => part.type === 'timeZoneName')
      ?.value.replace('GMT', 'UTC');
    const city = zone.split('/').at(-1)?.replaceAll('_', ' ') ?? zone;
    return offset && offset !== city ? `${city} · ${offset}` : city;
  } catch {
    return zone;
  }
}
