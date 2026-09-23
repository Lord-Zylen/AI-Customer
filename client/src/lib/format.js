export const initials = name =>
  String(name || '?')
    .split(/\s+/)
    .map(n => n[0])
    .filter(Boolean)
    .join('')
    .slice(0, 2)
    .toUpperCase();

export const formatTime = d =>
  new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export const formatDateTime = d =>
  new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export const timeAgo = (d, now = Date.now()) => {
  if (!d) return '';
  const diff = Math.max(0, now - new Date(d).getTime());
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(d).toLocaleString([], { month: 'short', day: 'numeric' });
};

export const shortDate = d =>
  new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

export const fmtCount = n =>
  new Intl.NumberFormat([], { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);