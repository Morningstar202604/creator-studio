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

const REQUIRED: Array<{ kind: string; key: string; label: string; stage: string }> = [
  { kind: 'topic-card', key: 'topic', label: '选题卡', stage: 'topic' },
  { kind: 'research-notes', key: 'research', label: '资料卡', stage: 'research' },
  { kind: 'script', key: 'script', label: '脚本', stage: 'script' },
  { kind: 'publish-pack', key: 'package', label: '发布包（标题/简介/标签）', stage: 'package' },
];

export function buildChecklist(artifacts: ArtifactSummary[]): ChecklistItem[] {
  const items: ChecklistItem[] = REQUIRED.map((requirement) => {
    const found = artifacts.filter((artifact) => artifact.kind === requirement.kind);
    return {
      key: requirement.key,
      label: requirement.label,
      ok: found.length > 0,
      detail: found.length > 0 ? `${found.length} 个版本` : '尚未生成',
      stage: requirement.stage,
    };
  });

  items.push({
    key: 'cover',
    label: '封面 brief',
    ok: artifacts.some((artifact) => artifact.kind === 'publish-pack'),
    detail: '封面文案包含在发布包中',
    stage: 'package',
  });

  return items;
}

export function isExportableKind(kind: string): boolean {
  return kind === 'topic-card' || kind === 'research-notes' || kind === 'script' || kind === 'publish-pack';
}

export function exportFileName(now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `publish-${stamp}.zip`;
}
