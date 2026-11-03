import { DAY, HOUR, MINUTE } from '../time.ts';

// C0 and C1 controls and DEL (escape sequences, carriage returns, newlines), Unicode line separators and bidirectional
// overrides: none of them may reach the terminal from a stored value. A backslash is escaped too, so a literal `\x1b` in
// a value reads `\\x1b` and cannot pass for an escaped control character.
const CONTROLS = /[\\\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * A stored value (a job title, a client name) as visible text: every terminal control character is shown as an escape
 * (`\x1b`, `\u202e`) instead of being written, so a value cannot move the cursor, clear the screen or hide rows. A backslash
 * is shown doubled (`\\`), so the output reads back unambiguously.
 */
export function escapeControls(text: string): string {
  return text.replace(CONTROLS, (char) => {
    if (char === '\\') return '\\\\';
    const code = char.charCodeAt(0);
    return code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

/** Render rows as aligned columns with a header. Cells are escaped before their widths are measured. */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const cells = rows.map((row) => row.map(escapeControls));
  const widths = headers.map((header, index) => Math.max(header.length, ...cells.map((row) => (row[index] ?? '').length)));
  const line = (cells: readonly string[]) => cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  ').trimEnd();
  return [line(headers), ...cells.map(line)].join('\n');
}

export function relative(ms: number): string {
  const abs = Math.abs(ms);
  const amount = abs >= DAY ? `${Math.floor(abs / DAY)}d` : abs >= HOUR ? `${Math.floor(abs / HOUR)}h` : `${Math.max(1, Math.floor(abs / MINUTE))}m`;
  return ms >= 0 ? `in ${amount}` : `${amount} ago`;
}

export function shortTime(ms: number | null): string {
  return ms === null ? '-' : new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
