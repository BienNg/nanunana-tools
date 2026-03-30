'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ScanGoogleSheetResult } from '@/lib/sync/googleSheetSync';

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
      <div className="bg-white rounded-lg shadow-2xl w-11/12 max-w-6xl max-h-[90vh] flex flex-col font-sans overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center bg-gray-50">
          <h2 id="scan-preview-title" className="text-xl font-semibold text-gray-800">
            Review Import: {scanResult.workbookTitle}
          </h2>
          <button
            onClick={onClose}
            disabled={isImporting}
            className="text-gray-500 hover:text-gray-700 disabled:opacity-50"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-200 px-6 pt-4 bg-gray-50 overflow-x-auto no-scrollbar">
          {sheets.map((sheet, idx) => (
            <button
              key={idx}
              onClick={() => setActiveTab(idx)}
              className={`px-4 py-2 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
                activeTab === idx
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {sheet.title}
            </button>
          ))}
          {sheets.length === 0 && (
            <div className="px-4 py-2 text-sm text-gray-500">No sheets found</div>
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
                        <td className="px-4 py-2 border-r border-gray-200">{row['Folien'] || ''}</td>
                        <td className="px-4 py-2 border-r border-gray-200">{row['Datum'] || ''}</td>
                        <td className="px-4 py-2 border-r border-gray-200">{row['von'] || ''}</td>
                        <td className="px-4 py-2 border-r border-gray-200">{row['bis'] || ''}</td>
                        <td className="px-4 py-2 border-r border-gray-200">{row['Lehrer'] || ''}</td>
                        {activeSheet.headers.students.map((student, cIdx) => (
                          <td key={cIdx} className="px-4 py-2 border-r border-gray-200">
                            {row[student.name] || ''}
                          </td>
                        ))}
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
