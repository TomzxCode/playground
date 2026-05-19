import { MILESTONES } from './milestones';

function durationHours(a, b) {
  return (new Date(b) - new Date(a)) / 3_600_000;
}

export function computePhaseStats(features) {
  const phases = [];

  for (let i = 0; i < MILESTONES.length - 1; i++) {
    const from = MILESTONES[i].id;
    const to = MILESTONES[i + 1].id;
    const label = `${MILESTONES[i].label} → ${MILESTONES[i + 1].label}`;

    const durations = features
      .filter(f => f.milestones[from] && f.milestones[to])
      .map(f => durationHours(f.milestones[from], f.milestones[to]))
      .filter(d => d >= 0);

    if (durations.length === 0) {
      phases.push({ from, to, label, count: 0, avg: null, median: null, max: null });
      continue;
    }

    const sorted = [...durations].sort((a, b) => a - b);
    const avg = sorted.reduce((s, v) => s + v, 0) / sorted.length;
    const median = sorted[Math.floor(sorted.length / 2)];
    const max = sorted[sorted.length - 1];

    phases.push({ from, to, label, count: durations.length, avg, median, max });
  }

  return phases;
}

export function formatHours(hours) {
  if (hours == null) return '—';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}
