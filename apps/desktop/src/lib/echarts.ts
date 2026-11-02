import * as echarts from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

/**
 * ECharts, assembled from the modules this app actually draws.
 *
 * The full `echarts` entry pulls in every chart type, map, 3D and SVG renderer —
 * 1.09 MB minified for two chart types. Registering only line, bar, grid, tooltip,
 * legend and the canvas renderer keeps the same API while shipping a fraction of
 * it. Everything else in the app imports `EChartsOption` as a *type* from
 * `echarts`, which is erased at build time and does not pull the runtime in.
 */
echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

export { echarts };
