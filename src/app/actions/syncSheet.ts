'use server';

import { runGoogleSheetSync } from '@/lib/sync/googleSheetSync';

export async function syncGoogleSheet(url: string) {
  return runGoogleSheetSync(url);
}
