'use client';

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ScanGoogleSheetResult, ScannedSheet } from '@/lib/sync/googleSheetSync';

const DATA_COLUMN_KEYS = ['Folien', 'Datum', 'von', 'bis', 'Lehrer'] as const;

function isEmptyCellValue(v: unknown): boolean {
  return String(v ?? '').trim().length === 0;
}

function countEmptyCellsInSheet(sheet: ScannedSheet): number {
  let n = 0;
  for (const row of sheet.sampleRows) {
    for (const key of DATA_COLUMN_KEYS) {
      if (isEmptyCellValue(row.values[key])) n++;
    }
    for (const s of sheet.headers.students) {
      if (isEmptyCellValue(row.values[s.name])) n++;
    }
  }
  return n;
}

function studentAttendanceCellClass(
  text: string,
  colorStatus: 'Present' | 'Absent' | null | undefined
): string {
  const t = String(text).trim();
  const absentByText = /\babwesend\b/i.test(t) || /\babsent\b/i.test(t);
  const presentByText = t.length > 0 && !absentByText;

  if (colorStatus === 'Absent' || absentByText) {
    return 'bg-red-100/90 text-red-950 border-r border-red-200/80';
  }
  if (colorStatus === 'Present' || presentByText) {
    return 'bg-emerald-50/95 text-emerald-950 border-r border-emerald-200/70';
  }
  return 'border-r border-gray-200';
}

type ScanPreviewModalProps = {
  isOpen: boolean;
  scanResult: Extract<ScanGoogleSheetResult, { success: true }> | null;
  onClose: () => void;
  onConfirm: () => void;
  isImporting: boolean;
};

export default function ScanPreviewModal({
  isOpen,
  scanResult,
  onClose,
  onConfirm,
  isImporting,
}: ScanPreviewModalProps) {
  const [activeTab, setActiveTab] = useState(0);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (isOpen) setActiveTab(0);
  }, [isOpen, scanResult]);

  const emptyCellCount = useMemo(() => {
    if (!isOpen || !scanResult || !mounted) return 0;
    const sheet = scanResult.sheets[activeTab];
    return sheet ? countEmptyCellsInSheet(sheet) : 0;
  }, [isOpen, scanResult, activeTab, mounted]);

  if (!isOpen || !scanResult || !mounted) return null;

  const sheets = scanResult.sheets;
  const activeSheet = sheets[activeTab];

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="scan-preview-title"
    >
      <div className="bg-white rounded-lg shadow-2xl w-[min(96vw,1920px)] max-h-[92vh] flex flex-col font-sans overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center gap-4 bg-gray-50">
          <h2 id="scan-preview-title" className="text-xl font-semibold text-gray-800 min-w-0 truncate">
            Review Import: {scanResult.workbookTitle}
          </h2>
          <div className="flex shrink-0 items-center gap-2">
            {emptyCellCount > 0 && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-yellow-100 px-2.5 py-1 text-sm font-medium text-yellow-950 ring-1 ring-yellow-300/80"
                title={`${emptyCellCount} empty ${emptyCellCount === 1 ? 'cell' : 'cells'} on this sheet`}
              >
                <span className="material-symbols-outlined text-[1.125rem] leading-none" aria-hidden>
                  error
                </span>
                <span aria-live="polite">{emptyCellCount}</span>
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              disabled={isImporting}
              className="text-gray-500 hover:text-gray-700 disabled:opacity-50"
              aria-label="Close preview"
            >
              <span className="material-symbols-outlined">close</span>
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div
          className="flex min-h-[3.25rem] items-end gap-1 border-b border-gray-200 bg-gray-50 px-6 pb-0 pt-2 overflow-x-auto no-scrollbar"
          role="tablist"
          aria-label="Workbook sheets"
        >
          {sheets.map((sheet, idx) => (
            <button
              key={idx}
              type="button"
              role="tab"
              aria-selected={activeTab === idx}
              onClick={() => setActiveTab(idx)}
              className={`shrink-0 rounded-t-lg border border-b-0 px-5 py-3 text-sm font-semibold whitespace-nowrap transition-colors ${
                activeTab === idx
                  ? 'relative z-[1] -mb-px border-gray-200 bg-white text-blue-600 shadow-[0_-1px_0_0_white]'
                  : 'border-transparent bg-transparent text-gray-600 hover:border-gray-200 hover:bg-gray-100/80 hover:text-gray-900'
              }`}
            >
              {sheet.title}
            </button>
          ))}
          {sheets.length === 0 && (
            <div className="flex min-h-[3.25rem] items-center px-4 py-3 text-sm text-gray-500">No sheets found</div>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-6 bg-white">
          {activeSheet ? (
            <div className="border border-gray-200 rounded-md overflow-x-auto">
              <table className="w-full text-left text-sm text-gray-700">
                <thead className="bg-gray-100 text-gray-600 font-semibold border-b border-gray-200">
                  <tr>
                    <th className="px-4 py-3 border-r border-gray-200 whitespace-nowrap">
                      Folien {activeSheet.headers.folien ? `(${activeSheet.headers.folien})` : ''}
                    </th>
                    <th className="px-4 py-3 border-r border-gray-200 whitespace-nowrap">
                      Datum {activeSheet.headers.datum ? `(${activeSheet.headers.datum})` : ''}
                    </th>
                    <th className="px-4 py-3 border-r border-gray-200 whitespace-nowrap">
                      von {activeSheet.headers.von ? `(${activeSheet.headers.von})` : ''}
                    </th>
                    <th className="px-4 py-3 border-r border-gray-200 whitespace-nowrap">
                      bis {activeSheet.headers.bis ? `(${activeSheet.headers.bis})` : ''}
                    </th>
                    <th className="px-4 py-3 border-r border-gray-200 whitespace-nowrap">
                      Lehrer {activeSheet.headers.lehrer.length > 0 ? `(${activeSheet.headers.lehrer.join(', ')})` : ''}
                    </th>
                    {activeSheet.headers.students.map((student, idx) => (
                      <th key={idx} className="px-4 py-3 border-r border-gray-200 whitespace-nowrap">
                        {student.name} {student.letters.length > 0 ? `(${student.letters.join(', ')})` : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {activeSheet.sampleRows.length > 0 ? (
                    activeSheet.sampleRows.map((row, rIdx) => (
                      <tr key={rIdx} className="hover:bg-gray-50">
                        <td
                          className={`px-4 py-2 border-r border-gray-200 ${
                            isEmptyCellValue(row.values['Folien'])
                              ? 'bg-yellow-100 ring-1 ring-inset ring-yellow-300/90'
                              : ''
                          }`}
                        >
                          {row.values['Folien'] || ''}
                        </td>
                        <td
                          className={`px-4 py-2 border-r border-gray-200 ${
                            isEmptyCellValue(row.values['Datum'])
                              ? 'bg-yellow-100 ring-1 ring-inset ring-yellow-300/90'
                              : ''
                          }`}
                        >
                          {row.values['Datum'] || ''}
                        </td>
                        <td
                          className={`px-4 py-2 border-r border-gray-200 ${
                            isEmptyCellValue(row.values['von'])
                              ? 'bg-yellow-100 ring-1 ring-inset ring-yellow-300/90'
                              : ''
                          }`}
                        >
                          {row.values['von'] || ''}
                        </td>
                        <td
                          className={`px-4 py-2 border-r border-gray-200 ${
                            isEmptyCellValue(row.values['bis'])
                              ? 'bg-yellow-100 ring-1 ring-inset ring-yellow-300/90'
                              : ''
                          }`}
                        >
                          {row.values['bis'] || ''}
                        </td>
                        <td
                          className={`px-4 py-2 border-r border-gray-200 ${
                            isEmptyCellValue(row.values['Lehrer'])
                              ? 'bg-yellow-100 ring-1 ring-inset ring-yellow-300/90'
                              : ''
                          }`}
                        >
                          {row.values['Lehrer'] || ''}
                        </td>
                        {activeSheet.headers.students.map((student, cIdx) => {
                          const cellText = row.values[student.name] || '';
                          const empty = isEmptyCellValue(cellText);
                          const tone = empty
                            ? 'bg-yellow-100 ring-1 ring-inset ring-yellow-300/90'
                            : studentAttendanceCellClass(cellText, row.studentAttendance[student.name]);
                          return (
                            <td key={cIdx} className={`px-4 py-2 ${tone}`}>
                              {cellText}
                            </td>
                          );
                        })}
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td
                        colSpan={5 + activeSheet.headers.students.length}
                        className="px-4 py-8 text-center text-gray-500"
                      >
                        No data rows found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-gray-500 text-center py-10">No data available to preview.</div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 flex justify-end gap-3">
          <button
            onClick={onClose}
            disabled={isImporting}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isImporting}
            className="px-6 py-2 text-sm font-medium text-white bg-[#ff7a59] rounded hover:bg-[#ff8f73] focus:ring-2 focus:ring-offset-2 focus:ring-[#ff7a59] disabled:opacity-50 transition-colors flex items-center gap-2 shadow-sm"
          >
            {isImporting ? (
              <>
                <span className="material-symbols-outlined animate-spin text-sm">sync</span>
                Importing...
              </>
            ) : (
              'Confirm & Import'
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
