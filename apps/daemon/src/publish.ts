import { crc32 } from 'node:zlib';

export type ZipEntry = {
  /** Path inside the archive, always forward-slash, always relative. */
  name: string;
  content: Buffer;
};

export type ChecklistItem = {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
  /** Route hint the UI can offer to go fix the gap. */
  stage: string;
  /** Required items gate export; optional ones only inform. */
  required: boolean;
};

export type ArtifactSummary = {
  kind: string;
  path: string;
  createdAt: string;
};

/** Zip format cannot store dates before 1980. */
const DOS_EPOCH_YEAR = 1980;

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(date.getUTCFullYear(), DOS_EPOCH_YEAR);
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hour = date.getUTCHours();
  const minute = date.getUTCMinutes();
  const second = Math.floor(date.getUTCSeconds() / 2);
  return {
    time: (hour << 11) | (minute << 5) | second,
    date: ((year - DOS_EPOCH_YEAR) << 9) | (month << 5) | day,
  };
}

/**
 * Builds a store-only (no compression) zip archive. Markdown payloads are small
 * and compressing them would add complexity for little gain.
 */
export function buildZip(entries: ZipEntry[], now = new Date()): Buffer {
  const { time, date } = dosDateTime(now);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.content) >>> 0;
    const size = entry.content.length;

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);

    locals.push(local, entry.content);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);

    centrals.push(central);
    offset += local.length + entry.content.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuffer, end]);
}

export type ChecklistExtra = {
  /** Result of scanning the latest script for the attached profile's banned words. */
  style?: { bannedWords: string[]; hits: Array<{ word: string; count: number }>; checked: boolean } | null;
  /** Card counts per entity type, so card-backed stages can be judged too. */
  entityCounts?: EntityCounts;
  /**
   * The project's scenario pack. Its required stages become the checklist, so a
   * novel project is never asked for a shot list and a video project is never
   * asked for a chapter. Missing means "use the legacy video list".
   */
  scenario?: ScenarioChecklistSource | null;
};

export type ScenarioChecklistSource = {
  stages: Array<{
    key: string;
    label: string;
    required: boolean;
    produces: string[];
    /** Stages backed by cards count cards instead of artifacts. */
    view?: string;
    entityType?: string;
  }>;
};

export type EntityCounts = Record<string, number>;

export function buildChecklist(artifacts: ArtifactSummary[], extra: ChecklistExtra = {}): ChecklistItem[] {
  const items: ChecklistItem[] = [];

  if (extra.scenario !== undefined && extra.scenario !== null) {
    const counts = extra.entityCounts ?? {};
    for (const stage of extra.scenario.stages) {
      // Card-backed stages (novel chapters, course lessons) have no artifact; the
      // work lives in entity cards, so counting artifacts would always read "missing".
      // Board and document stages are the same shape with a different presentation.
      if (
        (stage.view === 'entities' || stage.view === 'board' || stage.view === 'document') &&
        stage.entityType !== undefined
      ) {
        const cards = counts[stage.entityType] ?? 0;
        items.push({
          key: stage.key,
          label: stage.label,
          ok: cards > 0,
          detail: cards > 0 ? `${cards} 张卡片` : '还没有卡片',
          stage: stage.key,
          required: stage.required,
        });
        continue;
      }
      if (stage.produces.length === 0) {
        // A stage with no artifact (e.g. "发布") still shows up as a manual step so
        // the user sees the full pipeline rather than a truncated one.
        if (stage.required) {
          items.push({
            key: stage.key,
            label: stage.label,
            ok: false,
            detail: '需手动完成',
            stage: stage.key,
            required: false,
          });
        }
        continue;
      }
      for (const kind of stage.produces) {
        const found = artifacts.filter((artifact) => artifact.kind === kind);
        items.push({
          key: `${stage.key}:${kind}`,
          label: `${stage.label} · ${kindLabel(kind)}`,
          ok: found.length > 0,
          detail: found.length > 0 ? `${found.length} 个版本` : stage.required ? '尚未生成' : '可选，未生成',
          stage: stage.key,
          required: stage.required,
        });
      }
    }
  } else {
    for (const requirement of LEGACY_REQUIRED) {
      const found = artifacts.filter((artifact) => artifact.kind === requirement.kind);
      items.push({
        key: requirement.key,
        label: requirement.label,
        ok: found.length > 0,
        detail: found.length > 0 ? `${found.length} 个版本` : requirement.required ? '尚未生成' : '可选，未生成',
        stage: requirement.stage,
        required: requirement.required,
      });
    }

    items.push({
      key: 'cover',
      label: '封面 brief',
      ok: artifacts.some((artifact) => artifact.kind === 'publish-pack'),
      detail: '封面文案包含在发布包中',
      stage: 'package',
      required: true,
    });

    // Subtitle export is a bonus deliverable: missing it never blocks the pack.
    const subtitles = artifacts.filter((artifact) => artifact.kind === 'subtitle').length;
    items.push({
      key: 'subtitle',
      label: '字幕 SRT',
      ok: subtitles > 0,
      detail: subtitles > 0 ? `${subtitles} 个版本` : '可选，脚本页可一键导出',
      stage: 'script',
      required: false,
    });
  }

  // Style lint is advisory: it reports banned words but must not hold the export.
  const style = extra.style ?? null;
  if (style === null) {
    items.push({
      key: 'style',
      label: '风格检查',
      ok: true,
      detail: '未挂载风格档案',
      stage: 'settings',
      required: false,
    });
  } else {
    const hitText = !style.checked
      ? `尚无脚本可查（${style.bannedWords.length} 个禁用词待查）`
      : style.hits.length === 0
        ? `未命中 ${style.bannedWords.length} 个禁用词`
        : style.hits.map((hit) => `${hit.word}×${hit.count}`).join('、');
    // Not ok when there is nothing to scan yet: "unchecked" must not read as "clean".
    items.push({
      key: 'style',
      label: '风格检查',
      ok: style.checked && style.hits.length === 0,
      detail: hitText,
      stage: 'script',
      required: false,
    });
  }

  return items;
}

const LEGACY_REQUIRED: Array<{ kind: string; key: string; label: string; stage: string; required: boolean }> = [
  { kind: 'topic-card', key: 'topic', label: '选题卡', stage: 'topic', required: true },
  { kind: 'research-notes', key: 'research', label: '资料卡', stage: 'research', required: true },
  { kind: 'script', key: 'script', label: '脚本', stage: 'script', required: true },
  { kind: 'shot-list', key: 'shotlist', label: '分镜表', stage: 'shotlist', required: false },
  { kind: 'publish-pack', key: 'package', label: '发布包（标题/简介/标签）', stage: 'package', required: true },
];

function kindLabel(kind: string): string {
  switch (kind) {
    case 'topic-card':
      return '选题卡';
    case 'research-notes':
      return '资料卡';
    case 'script':
      return '脚本';
    case 'shot-list':
      return '分镜表';
    case 'subtitle':
      return '字幕';
    case 'publish-pack':
      return '发布包';
    case 'review-report':
      return '复盘报告';
    case 'outline':
      return '大纲';
    case 'chapter':
      return '章节';
    default:
      return kind;
  }
}

export function isExportableKind(kind: string): boolean {
  return (
    kind === 'topic-card' ||
    kind === 'research-notes' ||
    kind === 'script' ||
    kind === 'shot-list' ||
    kind === 'subtitle' ||
    kind === 'publish-pack' ||
    kind === 'outline' ||
    kind === 'chapter'
  );
}

export function exportFileName(now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `publish-${stamp}.zip`;
}
