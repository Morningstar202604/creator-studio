import { useEffect, useRef } from 'react';
import type React from 'react';
import type { EChartsOption } from 'echarts';
import { useCanvasTheme } from '../lib/canvasTheme';

/**
 * Thin ECharts wrapper. The library is loaded lazily so the editor pages never
 * pay for it, and the instance is disposed on unmount to avoid leaked timers.
 *
 * Theme: ECharts renders to canvas and cannot see CSS variables, so the option
 * builders below take a palette derived from the live tokens. Without that, dark
 * mode drew dark text and dark axis lines on a dark card — the chart looked empty.
 */
export function Chart({
  option,
  height = 240,
  label = '数据图表',
}: {
  option: EChartsOption;
  height?: number;
  label?: string;
}): React.ReactElement {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<{ dispose: () => void; resize: () => void; setOption: (option: EChartsOption, opts?: { notMerge?: boolean }) => void } | null>(null);
  const theme = useCanvasTheme();

  useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | null = null;

    if (container.current === null) return undefined;
    // Dynamic import keeps the chart runtime out of the main bundle: only pages
    // that actually draw a chart download it, and the modular build in
    // lib/echarts means that download is line/bar only.
    void import('../lib/echarts').then(({ echarts }) => {
      if (disposed || container.current === null) return;
      const instance = echarts.init(container.current, undefined, { renderer: 'canvas' });
      instance.setOption(option);
      chart.current = instance;
      observer =
        typeof ResizeObserver === 'undefined'
          ? null
          : new ResizeObserver(() => chart.current?.resize());
      observer?.observe(container.current);
    });

    return () => {
      disposed = true;
      observer?.disconnect();
      chart.current?.dispose();
      chart.current = null;
    };
    // The instance is created once; option updates go through the effect below.
  }, []);

  // A theme flip must repaint; the container itself is not recreated.
  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true });
  }, [option, theme.mode]);

  return <div ref={container} className="chart" style={{ height }} role="img" aria-label={label} />;
}

/** Chart palette derived from the design tokens; keeps light/dark in step. */
export type ChartPalette = {
  series: string[];
  axis: string;
  grid: string;
  text: string;
  tooltipBg: string;
  tooltipBorder: string;
};

const SERIES_LIGHT = ['#2e6f6a', '#8a5e12', '#35567d', '#b83a2e', '#2f6b43', '#7c6f9c'];
const SERIES_DARK = ['#6fb3ac', '#d6a84e', '#8ab4e0', '#e57b6d', '#7bc195', '#a99cc9'];

export function chartPalette(theme: {
  mode: 'light' | 'dark';
  border: string;
  fg: string;
  muted: string;
  surface: string;
}): ChartPalette {
  const dark = theme.mode === 'dark';
  return {
    series: dark ? SERIES_DARK : SERIES_LIGHT,
    axis: theme.border,
    grid: dark ? 'rgba(255,255,255,0.10)' : 'rgba(140,136,128,0.18)',
    text: theme.muted,
    tooltipBg: theme.surface,
    tooltipBorder: theme.border,
  };
}

const FONT = 11;

function baseOption(palette: ChartPalette): EChartsOption {
  return {
    color: palette.series,
    textStyle: { fontFamily: 'inherit', color: palette.text },
    tooltip: {
      trigger: 'axis',
      backgroundColor: palette.tooltipBg,
      borderColor: palette.tooltipBorder,
      textStyle: { color: palette.text, fontSize: FONT },
    },
    legend: { top: 0, right: 0, textStyle: { fontSize: FONT, color: palette.text } },
    grid: { left: 8, right: 16, top: 28, bottom: 8, containLabel: true },
  };
}

export function trendOption(
  labels: string[],
  series: Array<{ name: string; values: number[] }>,
  palette: ChartPalette,
): EChartsOption {
  return {
    ...baseOption(palette),
    xAxis: {
      type: 'category',
      data: labels,
      axisLine: { lineStyle: { color: palette.axis } },
      axisLabel: { fontSize: FONT, color: palette.text },
    },
    yAxis: {
      type: 'value',
      axisLine: { show: false },
      splitLine: { lineStyle: { color: palette.grid } },
      axisLabel: { fontSize: FONT, color: palette.text },
    },
    series: series.map((entry) => ({
      name: entry.name,
      type: 'line',
      smooth: true,
      symbolSize: 5,
      data: entry.values,
      areaStyle: { opacity: 0.08 },
    })),
  };
}

export function barsOption(labels: string[], values: number[], name: string, palette: ChartPalette): EChartsOption {
  return {
    ...baseOption(palette),
    grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
    xAxis: {
      type: 'category',
      data: labels,
      axisLine: { lineStyle: { color: palette.axis } },
      axisLabel: { fontSize: FONT, color: palette.text },
    },
    yAxis: {
      type: 'value',
      axisLine: { show: false },
      splitLine: { lineStyle: { color: palette.grid } },
      axisLabel: { fontSize: FONT, color: palette.text },
    },
    series: [{ name, type: 'bar', data: values, barMaxWidth: 28, itemStyle: { borderRadius: [4, 4, 0, 0] } }],
  };
}
