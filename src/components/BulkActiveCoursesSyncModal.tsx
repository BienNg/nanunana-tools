'use client';

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '@/lib/supabase/client';
import ScanPreviewModal from '@/components/ScanPreviewModal';
import type {
  ScanGoogleSheetResult,
  SkippedAttendanceCellsBySheet,
  SkippedRowsBySheet,
  SyncGoogleSheetResult,
  TeacherAliasResolution,
  WorkbookClassType,
  SyncGroupApplySummary,
} from '@/lib/sync/googleSheetSync';
import type { StudentAliasResolution } from '@/lib/sync/googleSheetStudentSync';

type ScanSuccess = Extract<ScanGoogleSheetResult, { success: true }>;

type GroupTarget = {
  id: string;
  name: string;
  spreadsheetUrl: string;
  activeCourseCount: number;
};

type NdjsonLine =
  | { kind: 'progress-status'; message: string }
  | { kind: 'progress-sheet'; title: string; current: number; total: number }
  | { kind: 'progress-db'; message: string }
  | { kind: 'done'; result: unknown }
  | null;

function parseSyncNdjsonLine(line: string): NdjsonLine {
  if (!line) return null;
  let msg: {
    event?: string;
    type?: string;
    message?: string;
    title?: string;
    current?: number;
    total?: number;
    result?: unknown;
  };
  try {
    msg = JSON.parse(line) as typeof msg;
  } catch {
    return null;
  }
  if (msg.event === 'progress' && msg.type === 'status' && msg.message) {
    return { kind: 'progress-status', message: msg.message };
  }
  if (
    msg.event === 'progress' &&
    msg.type === 'sheet' &&
    msg.title != null &&
    msg.current != null &&
    msg.total != null
  ) {
    return { kind: 'progress-sheet', title: msg.title, current: msg.current, total: msg.total };
  }
  if (msg.event === 'progress' && msg.type === 'db' && msg.message) {
    return { kind: 'progress-db', message: msg.message };
  }
  if (msg.event === 'done' && msg.result !== undefined) {
    return { kind: 'done', result: msg.result };
  }
  return null;
}

async function streamScanFromUrl(
  url: string,
  onProgress: (message: string) => void
): Promise<ScanGoogleSheetResult | null> {
  const res = await fetch('/api/sync-sheet/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    let errText = res.statusText;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) errText = j.error;
    } catch {
      // ignore
    }
    throw new Error(errText);
  }
  if (!res.body) throw new Error('No response body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResult: ScanGoogleSheetResult | null = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl < 0) break;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      const parsed = parseSyncNdjsonLine(line);
      if (!parsed) continue;
      if (parsed.kind === 'progress-status') onProgress(parsed.message);
      if (parsed.kind === 'progress-sheet') onProgress(`Tab ${parsed.current}/${parsed.total}: ${parsed.title}`);
      if (parsed.kind === 'done') finalResult = parsed.result as ScanGoogleSheetResult;
    }
  }
  return finalResult;
}

async function streamImportFromSnapshot(
  reviewSnapshot: ScanSuccess,
  payload: {
    skippedRowsBySheet: SkippedRowsBySheet;
    skippedAttendanceCellsBySheet: SkippedAttendanceCellsBySheet;
    teacherAliasResolutions: TeacherAliasResolution[];
    studentAliasResolutions: StudentAliasResolution[];
    workbookClassType?: WorkbookClassType;
  },
  handlers: {
    onProgress: (message: string) => void;
    onDbLine: (line: string) => void;
  }
): Promise<SyncGoogleSheetResult | null> {
  const cloned =
    typeof structuredClone === 'function'
      ? structuredClone(reviewSnapshot)
      : JSON.parse(JSON.stringify(reviewSnapshot));
  const res = await fetch('/api/sync-sheet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reviewSnapshot: cloned,
      skippedRowsBySheet: payload.skippedRowsBySheet,
      skippedAttendanceCellsBySheet: payload.skippedAttendanceCellsBySheet,
      teacherAliasResolutions: payload.teacherAliasResolutions,
      studentAliasResolutions: payload.studentAliasResolutions,
      ...(payload.workbookClassType != null ? { workbookClassType: payload.workbookClassType } : {}),
    }),
  });

  if (!res.ok) {
    let errText = res.statusText;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) errText = j.error;
    } catch {
      // ignore
    }
    throw new Error(errText);
  }
  if (!res.body) throw new Error('No response body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResult: SyncGoogleSheetResult | null = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl < 0) break;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      const parsed = parseSyncNdjsonLine(line);
      if (!parsed) continue;
      if (parsed.kind === 'progress-status') handlers.onProgress(parsed.message);
      if (parsed.kind === 'progress-sheet') handlers.onProgress(`Tab ${parsed.current}/${parsed.total}: ${parsed.title}`);
      if (parsed.kind === 'progress-db') handlers.onDbLine(parsed.message);
      if (parsed.kind === 'done') finalResult = parsed.result as SyncGoogleSheetResult;
    }
  }
  return finalResult;
}

export default function BulkActiveCoursesSyncModal({
  isOpen,
  onClose,
  onSyncComplete,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSyncComplete: () => void;
}) {
  const [targets, setTargets] = useState<GroupTarget[]>([]);
  const [scanResultsByGroup, setScanResultsByGroup] = useState<Record<string, ScanSuccess>>({});
  const [scanErrorsByGroup, setScanErrorsByGroup] = useState<Record<string, string>>({});
  const [scanProgressMessage, setScanProgressMessage] = useState('');
  const [isScanningAll, setIsScanningAll] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [isImportingOne, setIsImportingOne] = useState(false);
  const [isImportingAll, setIsImportingAll] = useState(false);
  const [importProgressByGroup, setImportProgressByGroup] = useState<Record<string, string>>({});
  const [importDbLogByGroup, setImportDbLogByGroup] = useState<Record<string, string[]>>({});
  const [importErrorsByGroup, setImportErrorsByGroup] = useState<Record<string, string>>({});
  const [importSummaryByGroup, setImportSummaryByGroup] = useState<Record<string, SyncGroupApplySummary>>({});
  const [scanLoadError, setScanLoadError] = useState('');
  const [mounted, setMounted] = useState(false);

  const selectedScan = selectedGroupId ? scanResultsByGroup[selectedGroupId] ?? null : null;
  const selectedImportDbLog = selectedGroupId ? importDbLogByGroup[selectedGroupId] ?? [] : [];
  const selectedImportProgress = selectedGroupId ? importProgressByGroup[selectedGroupId] ?? '' : '';
  const selectedImportSummary = selectedGroupId ? importSummaryByGroup[selectedGroupId] ?? null : null;

  const batchSummary = useMemo(() => {
    const list = Object.values(importSummaryByGroup);
    return {
      groupsUpdated: list.length,
      sessionsInserted: list.reduce((sum, row) => sum + row.totals.sessionsInserted, 0),
      sessionsUpdated: list.reduce((sum, row) => sum + row.totals.sessionsUpdated, 0),
      sessionsDeleted: list.reduce((sum, row) => sum + row.totals.sessionsDeleted, 0),
    };
  }, [importSummaryByGroup]);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const run = async () => {
      setTargets([]);
      setScanResultsByGroup({});
      setScanErrorsByGroup({});
      setScanProgressMessage('Loading active incomplete groups…');
      setIsScanningAll(true);
      setSelectedGroupId(null);
      setImportProgressByGroup({});
      setImportDbLogByGroup({});
      setImportErrorsByGroup({});
      setImportSummaryByGroup({});
      setScanLoadError('');

      const { data, error } = await supabase
        .from('courses')
        .select('group_id, groups:groups!inner(id, name, spreadsheet_url)')
        .or('sync_completed.is.false,sync_completed.is.null')
        .not('group_id', 'is', null);

      if (cancelled) return;
      if (error) {
        setScanLoadError(error.message);
        setIsScanningAll(false);
        return;
      }

      const grouped = new Map<string, GroupTarget>();
      for (const row of (data ?? []) as Array<{
        group_id: string | null;
        groups: { id: string; name: string; spreadsheet_url: string | null } | Array<{ id: string; name: string; spreadsheet_url: string | null }> | null;
      }>) {
        const group = Array.isArray(row.groups) ? row.groups[0] ?? null : row.groups;
        if (!row.group_id || !group?.id) continue;
        const spreadsheetUrl = String(group.spreadsheet_url ?? '').trim();
        if (!spreadsheetUrl) continue;
        const prev = grouped.get(group.id);
        if (prev) {
          prev.activeCourseCount += 1;
          continue;
        }
        grouped.set(group.id, {
          id: group.id,
          name: group.name ?? 'Unnamed group',
          spreadsheetUrl,
          activeCourseCount: 1,
        });
      }

      const nextTargets = [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name));
      setTargets(nextTargets);
      if (nextTargets.length === 0) {
        setScanProgressMessage('');
        setIsScanningAll(false);
        setScanLoadError('No active incomplete groups with a spreadsheet URL were found.');
        return;
      }

      const nextScans: Record<string, ScanSuccess> = {};
      const nextScanErrors: Record<string, string> = {};
      for (let i = 0; i < nextTargets.length; i++) {
        const target = nextTargets[i];
        setScanProgressMessage(`Scanning ${i + 1}/${nextTargets.length}: ${target.name}`);
        try {
          const scan = await streamScanFromUrl(target.spreadsheetUrl, (m) =>
            setScanProgressMessage(`Scanning ${i + 1}/${nextTargets.length}: ${target.name} — ${m}`)
          );
          if (scan?.success) nextScans[target.id] = scan;
          else nextScanErrors[target.id] = scan?.error ?? 'Scan finished without a result';
        } catch (err) {
          nextScanErrors[target.id] = err instanceof Error ? err.message : 'Scan failed';
        }
        if (cancelled) return;
      }
      setScanResultsByGroup(nextScans);
      setScanErrorsByGroup(nextScanErrors);
      const firstReady = nextTargets.find((t) => nextScans[t.id])?.id ?? null;
      setSelectedGroupId(firstReady);
      setScanProgressMessage('');
      setIsScanningAll(false);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const runImportForGroup = async (
    groupId: string,
    payload: {
      skippedRowsBySheet: SkippedRowsBySheet;
      skippedAttendanceCellsBySheet: SkippedAttendanceCellsBySheet;
      teacherAliasResolutions: TeacherAliasResolution[];
      studentAliasResolutions: StudentAliasResolution[];
      workbookClassType?: WorkbookClassType;
    }
  ): Promise<void> => {
    const scan = scanResultsByGroup[groupId];
    if (!scan) return;
    setImportErrorsByGroup((prev) => ({ ...prev, [groupId]: '' }));
    setImportDbLogByGroup((prev) => ({ ...prev, [groupId]: [] }));
    const result = await streamImportFromSnapshot(scan, payload, {
      onProgress: (message) => {
        setImportProgressByGroup((prev) => ({ ...prev, [groupId]: message }));
      },
      onDbLine: (line) => {
        setImportDbLogByGroup((prev) => ({ ...prev, [groupId]: [...(prev[groupId] ?? []), line] }));
      },
    });
    setImportProgressByGroup((prev) => ({ ...prev, [groupId]: '' }));
    if (!result) {
      setImportErrorsByGroup((prev) => ({ ...prev, [groupId]: 'Import finished without a result' }));
      return;
    }
    if (!result.success) {
      setImportErrorsByGroup((prev) => ({ ...prev, [groupId]: result.error ?? 'Import failed' }));
      return;
    }
    if (result.applySummary) {
      setImportSummaryByGroup((prev) => ({ ...prev, [groupId]: result.applySummary as SyncGroupApplySummary }));
    }
  };

  const handleImportSelected = async (
    skippedRowsBySheet: SkippedRowsBySheet,
    skippedAttendanceCellsBySheet: SkippedAttendanceCellsBySheet,
    teacherAliasResolutions: TeacherAliasResolution[],
    studentAliasResolutions: StudentAliasResolution[],
    workbookClassType?: WorkbookClassType
  ) => {
    if (!selectedGroupId) return;
    setIsImportingOne(true);
    try {
      await runImportForGroup(selectedGroupId, {
        skippedRowsBySheet,
        skippedAttendanceCellsBySheet,
        teacherAliasResolutions,
        studentAliasResolutions,
        workbookClassType,
      });
      onSyncComplete();
    } catch (err) {
      setImportErrorsByGroup((prev) => ({
        ...prev,
        [selectedGroupId]: err instanceof Error ? err.message : 'Import failed',
      }));
    } finally {
      setIsImportingOne(false);
    }
  };

  const handleImportAll = async (
    selectedSkippedRowsBySheet: SkippedRowsBySheet,
    selectedSkippedAttendanceCellsBySheet: SkippedAttendanceCellsBySheet,
    selectedTeacherAliasResolutions: TeacherAliasResolution[],
    selectedStudentAliasResolutions: StudentAliasResolution[],
    selectedWorkbookClassType?: WorkbookClassType
  ) => {
    const readyGroupIds = targets.map((t) => t.id).filter((id) => Boolean(scanResultsByGroup[id]));
    if (readyGroupIds.length === 0) return;
    setIsImportingAll(true);
    try {
      for (const groupId of readyGroupIds) {
        const useSelectedPayload = groupId === selectedGroupId;
        await runImportForGroup(groupId, {
          skippedRowsBySheet: useSelectedPayload ? selectedSkippedRowsBySheet : {},
          skippedAttendanceCellsBySheet: useSelectedPayload ? selectedSkippedAttendanceCellsBySheet : {},
          teacherAliasResolutions: useSelectedPayload ? selectedTeacherAliasResolutions : [],
          studentAliasResolutions: useSelectedPayload ? selectedStudentAliasResolutions : [],
          workbookClassType: useSelectedPayload ? selectedWorkbookClassType : undefined,
        });
      }
      onSyncComplete();
    } finally {
      setIsImportingAll(false);
    }
  };

  if (!isOpen || !mounted) return null;

  if (!selectedScan || isScanningAll) {
    return createPortal(
      <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/40 backdrop-blur-sm">
        <div className="w-[min(42rem,92vw)] rounded-2xl border border-white/20 bg-white p-6 shadow-2xl">
          <h2 className="text-xl font-bold text-on-surface">Update all active courses</h2>
          <p className="mt-1 text-sm text-on-surface-variant">
            {scanLoadError || scanProgressMessage || 'Preparing scans…'}
          </p>
          <div className="mt-5 flex items-center gap-3">
            <span className="material-symbols-outlined animate-spin text-primary">sync</span>
            <span className="text-sm font-medium text-on-surface-variant">Collecting review data for each group</span>
          </div>
          <div className="mt-6 flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-outline-variant/50 bg-white px-4 py-2 text-sm font-semibold text-on-surface"
            >
              Close
            </button>
          </div>
        </div>
      </div>,
      document.body
    );
  }

  return (
    <>
      <ScanPreviewModal
        isOpen={isOpen}
        scanResult={selectedScan}
        onClose={onClose}
        onConfirm={handleImportSelected}
        onConfirmAllGroups={handleImportAll}
        isImporting={isImportingOne}
        isImportingAllGroups={isImportingAll}
        importProgressMessage={selectedImportProgress}
        importDbLog={selectedImportDbLog}
        importApplySummary={selectedImportSummary}
        groupTabs={targets.map((target) => ({
          id: target.id,
          label: scanErrorsByGroup[target.id]
            ? `${target.name} (scan failed)`
            : `${target.name} (${target.activeCourseCount})`,
          disabled: !scanResultsByGroup[target.id],
        }))}
        activeGroupTabId={selectedGroupId ?? undefined}
        onSelectGroupTab={setSelectedGroupId}
        isConfirmAllGroupsDisabled={targets.every((target) => !scanResultsByGroup[target.id])}
      />
      {createPortal(
        <div className="fixed bottom-6 right-6 z-[240] w-[min(28rem,92vw)] rounded-xl border border-outline-variant/20 bg-white/95 p-4 shadow-xl backdrop-blur">
          <h3 className="text-sm font-semibold text-on-surface">Batch import summary</h3>
          <p className="mt-1 text-xs text-on-surface-variant">
            Groups updated: {batchSummary.groupsUpdated} · Sessions added: {batchSummary.sessionsInserted} · Sessions
            changed: {batchSummary.sessionsUpdated} · Sessions removed: {batchSummary.sessionsDeleted}
          </p>
          {selectedGroupId && importErrorsByGroup[selectedGroupId] ? (
            <p className="mt-2 text-xs font-medium text-error">{importErrorsByGroup[selectedGroupId]}</p>
          ) : null}
          {selectedGroupId && scanErrorsByGroup[selectedGroupId] ? (
            <p className="mt-2 text-xs font-medium text-error">{scanErrorsByGroup[selectedGroupId]}</p>
          ) : null}
        </div>,
        document.body
      )}
    </>
  );
}
