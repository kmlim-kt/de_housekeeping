// =====================================================================
// 그래프 (Chart.js — CDN, 버전 고정)
//   색은 css/app.css의 --series-1/2, --line, --muted 토큰에서 읽음 (라이트·다크 각각 검증한 값)
//   선 2px, 막대 끝 4px 둥글게, 격자는 옅게, 손가락/마우스를 올리면 값 표시
// =====================================================================

import { formatAmount, formatCompact } from '../core/money.js';

const CHART_JS = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js';
let loading = null;

/** Chart.js 불러오기 (한 번만). 실패하면 null — 그래프 대신 표를 보여 줌 */
export function loadChartJs() {
  if (window.Chart) return Promise.resolve(window.Chart);
  loading ??= new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = CHART_JS;
    s.onload = () => resolve(window.Chart ?? null);
    s.onerror = () => { loading = null; resolve(null); };
    document.head.append(s);
  });
  return loading;
}

function tokens() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  return { s1: v('--series-1'), s2: v('--series-2'), grid: v('--line'), muted: v('--muted'), text: v('--text'),
    surface: v('--surface') };
}

function baseOptions(t, { legend = false } = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 250 },
    interaction: { mode: 'index', intersect: false },   // 세로줄 기준으로 그 달 값 표시
    plugins: {
      legend: legend ? {
        display: true, position: 'top', align: 'start',
        labels: { color: t.text, boxWidth: 12, boxHeight: 12, useBorderRadius: true, borderRadius: 2, padding: 12 },
      } : { display: false },
      tooltip: {
        backgroundColor: t.text, titleColor: t.surface, bodyColor: t.surface, padding: 10, cornerRadius: 8,
        displayColors: legend, boxPadding: 4,
        callbacks: { label: (c) => `${c.dataset.label}: ${formatAmount(c.parsed.y)}원` },
      },
    },
    scales: {
      x: { grid: { display: false }, border: { color: t.grid }, ticks: { color: t.muted, maxRotation: 0, autoSkipPadding: 8 } },
      y: { grid: { color: t.grid }, border: { display: false },
           ticks: { color: t.muted, maxTicksLimit: 5, callback: (v) => formatCompact(v) } },
    },
  };
}

/**
 * 한 계열 선 그래프 (순자산 추이). 범례 없음 — 카드 제목이 계열 이름
 * @returns {Promise<object|null>} Chart 인스턴스 (화면을 떠날 때 destroy)
 */
export async function lineChart(canvas, labels, values, label) {
  const Chart = await loadChartJs();
  if (!Chart || !canvas.isConnected) return null;
  const t = tokens();
  return new Chart(canvas, {
    type: 'line',
    data: { labels, datasets: [{
      label, data: values, borderColor: t.s1, backgroundColor: t.s1, borderWidth: 2, tension: 0.25,
      pointRadius: 0, pointHoverRadius: 5, pointHoverBorderWidth: 2, pointHoverBorderColor: t.surface,
    }] },
    options: baseOptions(t),
  });
}

/**
 * 두 계열 묶음 막대 (월별 수입·지출). 범례 표시
 * @param {Array<{label: string, values: number[]}>} series 최대 2개 (색 순서 고정: 1=파랑, 2=주황)
 */
export async function groupedBarChart(canvas, labels, series) {
  const Chart = await loadChartJs();
  if (!Chart || !canvas.isConnected) return null;
  const t = tokens();
  const colors = [t.s1, t.s2];
  return new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: series.map((s, i) => ({
      label: s.label, data: s.values, backgroundColor: colors[i],
      borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: 'bottom',
      maxBarThickness: 18, categoryPercentage: 0.7, barPercentage: 0.85,
      borderColor: t.surface, borderWidth: { left: 1, right: 1 },   // 이웃 막대 사이 틈
    })) },
    options: baseOptions(t, { legend: true }),
  });
}
