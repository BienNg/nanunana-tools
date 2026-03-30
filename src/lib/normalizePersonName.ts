/**
 * Stable key for matching person names (teachers, etc.) across sheets and the DB.
 * Handles Unicode/diacritics, invisible/control characters (e.g. accidental backspace from paste),
 * Cyrillic/Greek homoglyphs, and common final-letter typos.
 */

/** Doubled at end is often intentional in romanized names (e.g. Johann, Ross). */
const TRAILING_DOUBLE_DENY = new Set('slnftzn');

/**
 * Cyrillic / Greek letters that are commonly substituted for Latin in spreadsheet text (IDN-homograph style).
 * Keep this list conservative to avoid collapsing real Cyrillic names incorrectly.
 */
const HOMOGLYPH_FOLD = new Map<number, string>([
  [0x0430, 'a'],
  [0x0435, 'e'],
  [0x043e, 'o'],
  [0x0440, 'p'],
  [0x0441, 'c'],
  [0x0443, 'y'],
  [0x0445, 'x'],
  [0x0455, 's'],
  [0x0456, 'i'],
  [0x0457, 'i'],
  [0x0458, 'j'],
  [0x03b1, 'a'],
  [0x03b5, 'e'],
  [0x03b9, 'i'],
  [0x03bf, 'o'],
  [0x03c1, 'p'],
  [0x03c5, 'u'],
  [0x03c7, 'x'],
]);

function foldHomoglyphs(s: string): string {
  return s.replace(/./gu, (ch) => {
    const cp = ch.codePointAt(0)!;
    return HOMOGLYPH_FOLD.get(cp) ?? ch;
  });
}

function stripInvisibleAndUnifySpaces(s: string): string {
  return s
    .replace(/\p{Cc}/gu, '')
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
    .replace(/\p{Cf}/gu, '');
}

/** Collapse a repeated final letter once per pass (e.g. Trangg → Trang). */
function foldTrailingDoubledLetterTypo(token: string): string {
  let t = token;
  for (let i = 0; i < 4; i++) {
    if (t.length < 5) break;
    const m = t.match(/^(.*)(.)\2$/u);
    if (!m) break;
    const ch = m[2];
    if (TRAILING_DOUBLE_DENY.has(ch)) break;
    t = m[1] + ch;
  }
  return t;
}

export function normalizePersonNameKey(raw: string | undefined | null): string {
  let s = String(raw ?? '').normalize('NFKC');
  s = stripInvisibleAndUnifySpaces(s);
  s = s.trim().toLowerCase();
  s = foldHomoglyphs(s);
  s = s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ');
  const parts = s.split(' ').map(foldTrailingDoubledLetterTypo).filter(Boolean);
  return parts.join(' ');
}
