export interface BarSeries {
  name: string;
  color: string;
}

export interface BarGroup {
  label: string;
  values: number[];
}

const WIDTH = 880;
const HEIGHT = 360;
const MARGIN = { top: 56, right: 24, bottom: 64, left: 76 };

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function format(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  if (value >= 10) return value.toFixed(0);
  return value.toFixed(2).replace(/\.00$/, "");
}

/** Render a small dependency-free grouped bar chart. */
export function barChart(options: {
  title: string;
  unit: string;
  series: BarSeries[];
  groups: BarGroup[];
}): string {
  const plotWidth = WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const allValues = options.groups.flatMap((group) => group.values);
  const max = Math.max(1, ...allValues);
  const scale = (value: number): number => (value / max) * plotHeight;

  const groupWidth = plotWidth / Math.max(1, options.groups.length);
  const barWidth = Math.min(46, (groupWidth * 0.68) / Math.max(1, options.series.length));
  const parts: string[] = [];

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img">`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="#f8fafc"/>`,
    `<text x="${MARGIN.left}" y="28" font-family="system-ui,sans-serif" font-size="18" font-weight="600" fill="#0f172a">${escapeXml(options.title)}</text>`,
    `<text x="${MARGIN.left}" y="46" font-family="system-ui,sans-serif" font-size="12" fill="#64748b">${escapeXml(options.unit)}</text>`
  );

  // Horizontal grid and y-axis labels.
  for (let i = 0; i <= 4; i++) {
    const value = (max / 4) * i;
    const y = MARGIN.top + plotHeight - scale(value);
    parts.push(
      `<line x1="${MARGIN.left}" y1="${y}" x2="${WIDTH - MARGIN.right}" y2="${y}" stroke="#e2e8f0" stroke-width="1"/>`,
      `<text x="${MARGIN.left - 10}" y="${y + 4}" text-anchor="end" font-family="system-ui,sans-serif" font-size="11" fill="#64748b">${escapeXml(format(value))}</text>`
    );
  }

  options.groups.forEach((group, groupIndex) => {
    const groupStart = MARGIN.left + groupIndex * groupWidth;
    const totalBarsWidth = options.series.length * barWidth;
    const startX = groupStart + (groupWidth - totalBarsWidth) / 2;

    options.series.forEach((series, seriesIndex) => {
      const value = group.values[seriesIndex] ?? 0;
      const height = scale(value);
      const x = startX + seriesIndex * barWidth;
      const y = MARGIN.top + plotHeight - height;
      parts.push(
        `<rect x="${x}" y="${y}" width="${Math.max(1, barWidth - 4)}" height="${height}" rx="3" fill="${series.color}"/>`,
        `<text x="${x + (barWidth - 4) / 2}" y="${y - 6}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" fill="#334155">${escapeXml(format(value))}</text>`
      );
    });

    parts.push(
      `<text x="${groupStart + groupWidth / 2}" y="${HEIGHT - MARGIN.bottom + 22}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" fill="#334155">${escapeXml(group.label)}</text>`
    );
  });

  // Legend.
  let legendX = WIDTH - MARGIN.right;
  for (const series of [...options.series].reverse()) {
    const textWidth = series.name.length * 7 + 18;
    legendX -= textWidth + 16;
    parts.push(
      `<rect x="${legendX}" y="22" width="10" height="10" rx="2" fill="${series.color}"/>`,
      `<text x="${legendX + 15}" y="31" font-family="system-ui,sans-serif" font-size="12" fill="#334155">${escapeXml(series.name)}</text>`
    );
  }

  parts.push("</svg>");
  return `${parts.join("\n")}\n`;
}
