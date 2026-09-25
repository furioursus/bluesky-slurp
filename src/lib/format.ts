export const fmt = (n: number | null | undefined) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
export const pct = (n: number | null | undefined) => (n == null ? '—' : `${n}%`);
export const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '—');

export const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

export const stamp = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const trend = (label: string, delta: number) =>
  `${label}: ${delta >= 3 ? `up ${delta.toFixed(1)} pts from` : delta <= -3 ? `down ${Math.abs(delta).toFixed(1)} pts from` : 'about the same as'} all time`;

export const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;
