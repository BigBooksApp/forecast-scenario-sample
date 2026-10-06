// Minimal SVG line chart with a shared crosshair tooltip. Series colors follow
// the categorical order (slot 1, 2, 3 …) and stay attached to the entity.

export const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shortDate = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
const longDate = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

let tooltipEl;

// series: [{ name, points: [{ date, balance }], color?, dashed? }]
//   or a band: { name, band: true, points: [{ date, low, median, high }] } — the median as the line,
//   the low–high range (10th–90th percentile) shaded behind it.
// opts: { fmt, compact, height, zeroLine (draw it when in range), includeZero (stretch to it), markers: [{ date, label }] }
export function lineChart(host, series, opts = {}) {
  series = series.filter((s) => s.points && s.points.length)
    .map((s) => (s.band ? { ...s, points: s.points.map((p) => ({ ...p, balance: p.median })) } : s));
  if (!series.length) { host.innerHTML = '<div class="placeholder">Nothing to plot.</div>'; return; }
  const fmt = opts.fmt || ((v) => v.toFixed(0));
  const compact = opts.compact || fmt;
  const W = 760, H = opts.height || 260, pad = { t: 14, r: 14, b: 26, l: 70 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;

  const t = (iso) => new Date(iso + 'T00:00:00').getTime();
  const allDates = series.flatMap((s) => s.points.map((p) => t(p.date)));
  const allVals = series.flatMap((s) => s.points.flatMap((p) => (s.band ? [p.low, p.high] : [p.balance])));
  const x0 = Math.min(...allDates), x1 = Math.max(...allDates) || x0 + 1;
  let lo = Math.min(...allVals), hi = Math.max(...allVals);
  if (opts.includeZero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (lo === hi) { lo -= 1; hi += 1; }
  const padY = (hi - lo) * 0.08; lo -= padY; hi += padY;
  const x = (ms) => pad.l + ((ms - x0) / (x1 - x0 || 1)) * iw;
  const y = (v) => pad.t + ih - ((v - lo) / (hi - lo)) * ih;

  let grid = '';
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((hi - lo) * i) / 4, yy = y(v).toFixed(1);
    grid += `<line x1="${pad.l}" y1="${yy}" x2="${W - pad.r}" y2="${yy}"/><text class="axis-label" x="${pad.l - 8}" y="${yy}" text-anchor="end" dominant-baseline="middle">${esc(compact(v))}</text>`;
  }
  const zero = opts.zeroLine && lo < 0 && hi > 0 ? `<line class="zero" x1="${pad.l}" x2="${W - pad.r}" y1="${y(0)}" y2="${y(0)}"/>` : '';
  const xl = [x0, (x0 + x1) / 2, x1].map((ms, i) =>
    `<text class="axis-label" x="${x(ms).toFixed(1)}" y="${H - 6}" text-anchor="${['start', 'middle', 'end'][i]}">${shortDate(new Date(ms).toISOString().slice(0, 10))}</text>`).join('');
  const markers = (opts.markers || []).map((m) =>
    `<line class="marker" x1="${x(t(m.date))}" x2="${x(t(m.date))}" y1="${pad.t}" y2="${pad.t + ih}"/><text class="marker-label" x="${x(t(m.date)) + 4}" y="${pad.t + 10}">${esc(m.label)}</text>`).join('');
  const lines = series.map((s, i) => {
    const color = s.color || SERIES[i % SERIES.length];
    const pts = s.points.map((p) => `${x(t(p.date)).toFixed(1)},${y(p.balance).toFixed(1)}`).join(' ');
    return `<polyline class="line${s.dashed ? ' dashed' : ''}" style="stroke:${color}" points="${pts}"/>`;
  }).join('');
  const bands = series.map((s, i) => {
    if (!s.band) return '';
    const up = s.points.map((p) => `${x(t(p.date)).toFixed(1)},${y(p.high).toFixed(1)}`);
    const down = [...s.points].reverse().map((p) => `${x(t(p.date)).toFixed(1)},${y(p.low).toFixed(1)}`);
    return `<polygon class="band" style="fill:${s.color || SERIES[i % SERIES.length]}" points="${up.concat(down).join(' ')}"/>`;
  }).join('');
  const dots = series.map((s, i) => `<circle class="hdot" r="4.5" style="fill:${s.color || SERIES[i % SERIES.length]}" cx="0" cy="0" opacity="0"/>`).join('');
  const legend = series.length > 1
    ? `<div class="legend">${series.map((s, i) => `<span><i style="background:${s.color || SERIES[i % SERIES.length]}${s.dashed ? ';opacity:.6' : ''}"></i>${esc(s.name)}</span>`).join('')}</div>`
    : series[0].band ? '<div class="legend"><span>line: median path · shaded: 10th–90th percentile</span></div>' : '';

  host.innerHTML = `${legend}<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || series.map((s) => s.name).join(', '))}">
    <g class="grid">${grid}</g>${xl}${zero}${markers}${bands}${lines}
    <line class="hoverline" x1="0" x2="0" y1="${pad.t}" y2="${pad.t + ih}" style="opacity:0"/>${dots}
    <rect class="overlay" x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}" fill="transparent"/></svg>`;

  if (!tooltipEl) { tooltipEl = document.createElement('div'); tooltipEl.className = 'tooltip'; document.body.appendChild(tooltipEl); }
  const svg = host.querySelector('svg');
  const hl = svg.querySelector('.hoverline');
  const hdots = svg.querySelectorAll('.hdot');
  const nearest = (pts, ms) => pts.reduce((b, p) => (Math.abs(t(p.date) - ms) < Math.abs(t(b.date) - ms) ? p : b), pts[0]);
  svg.querySelector('.overlay').addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const ms = x0 + Math.min(1, Math.max(0, (px - pad.l) / iw)) * (x1 - x0);
    const hits = series.map((s) => nearest(s.points, ms));
    const cx = x(t(hits[0].date));
    hl.setAttribute('x1', cx); hl.setAttribute('x2', cx); hl.style.opacity = '1';
    hits.forEach((p, i) => { hdots[i].setAttribute('cx', x(t(p.date))); hdots[i].setAttribute('cy', y(p.balance)); hdots[i].setAttribute('opacity', 1); });
    tooltipEl.innerHTML = `<div class="t-date">${longDate(hits[0].date)}</div>` + hits.map((p, i) =>
      `<div class="t-row">${series.length > 1 ? `<i style="background:${series[i].color || SERIES[i % SERIES.length]}"></i>${esc(series[i].name)} ` : ''}<b>${esc(fmt(p.balance))}</b>${series[i].band ? ` <span class="t-date">(${esc(fmt(p.low))} – ${esc(fmt(p.high))})</span>` : ''}</div>`).join('');
    tooltipEl.style.left = `${r.left + (cx / W) * r.width}px`;
    tooltipEl.style.top = `${r.top + (Math.min(...hits.map((p) => y(p.balance))) / H) * r.height}px`;
    tooltipEl.style.opacity = '1';
  });
  svg.querySelector('.overlay').addEventListener('mouseleave', () => {
    hl.style.opacity = '0'; tooltipEl.style.opacity = '0';
    hdots.forEach((d) => d.setAttribute('opacity', 0));
  });
}
