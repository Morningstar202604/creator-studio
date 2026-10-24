import { useEffect, useRef } from 'react';
import type React from 'react';
import type { EChartsOption } from 'echarts';

/**
 * Thin ECharts wrapper. The library is loaded lazily so the editor pages never
 * pay for it, and the instance is disposed on unmount to avoid leaked timers.
 */
export function Chart({ option, height = 240 }: { option: EChartsOption; height?: number }): React.ReactElement {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let chart: import('echarts').ECharts | null = null;
    let disposed = false;
    let observer: ResizeObserver | null = null;

    void import('echarts').then((echarts) => {
      if (disposed || container.current === null) return;
      chart = echarts.init(container.current, undefined, { renderer: 'canvas' });
      chart.setOption(option);
      observer = new ResizeObserver(() => chart?.resize());
      observer.observe(container.current);
    });

    return () => {
      disposed = true;
      observer?.disconnect();
      chart?.dispose();
    };
  }, [option]);

  return <div ref={container} className="chart" style={{ height }} role="img" aria-label="数据图表" />;
}

const PALETTE = ['#2e6f6a', '#8a5e12', '#35567d', '#b83a2e', '#2f6b43', '#7c6f9c'];

export function trendOption(
  labels: string[],
  series: Array<{ name: string; values: number[] }>,
): EChartsOption {
  return {
    color: PALETTE,
    grid: { left: 8, right: 16, top: 28, bottom: 8, containLabel: true },
    tooltip: { trigger: 'axis' },
    legend: { top: 0, right: 0, textStyle: { fontSize: 11 } },
    xAxis: {
      type: 'category',
      data: labels,
      axisLine: { lineStyle: { color: '#8c8880' } },
      axisLabel: { fontSize: 11 },
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: 'rgba(140,136,128,0.18)' } },
      axisLabel: { fontSize: 11 },
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

export function barsOption(labels: string[], values: number[], name: string): EChartsOption {
  return {
    color: PALETTE,
    grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: labels, axisLabel: { fontSize: 11 } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: 'rgba(140,136,128,0.18)' } } },
    series: [{ name, type: 'bar', data: values, barMaxWidth: 28, itemStyle: { borderRadius: [4, 4, 0, 0] } }],
  };
}

export function donutOption(data: Array<{ name: string; value: number }>): EChartsOption {
  return {
    color: PALETTE,
    tooltip: { trigger: 'item' },
    legend: { bottom: 0, textStyle: { fontSize: 11 } },
    series: [
      {
        type: 'pie',
        radius: ['46%', '68%'],
        center: ['50%', '44%'],
        avoidLabelOverlap: true,
        itemStyle: { borderWidth: 2, borderColor: 'transparent' },
        label: { show: false },
        data,
      },
    ],
  };
}
