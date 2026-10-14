import { Share } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';

/**
 * Session log: everything printed with console.log / warn / error is ALSO
 * appended to a text file on the phone (Documents/logs/session-<time>.log),
 * one file per app launch.
 *
 * Why: Metro's log stream drops when the connection to the phone hiccups
 * ("Connecting to: iPhone…"), and whatever is printed meanwhile is gone. The
 * file keeps everything, survives disconnects, and is the session log the
 * evaluation needs anyway. Share it from the Home screen ("Αποστολή logs").
 *
 * writeToLogFile() writes ONLY to the file (no console) - used for the bulky
 * calibration data dumps, so they don't flood Metro.
 */

const LOG_DIR = 'logs';
const FLUSH_MS = 1000;

let file = null;
let buffer = [];
let installed = false;

function stringify(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function flush() {
  if (!file || buffer.length === 0) return;
  const chunk = buffer.join('\n') + '\n';
  buffer = [];
  try {
    file.write(chunk, { append: true });
  } catch (e) {
    // never let logging break the app; keep the console working
    installed = false;
  }
}

/** Call once, as early as possible (App.js). Safe to call twice. */
export function installSessionLog() {
  if (installed || global.__eyeauthSessionLog) return;
  try {
    const dir = new Directory(Paths.document, LOG_DIR);
    if (!dir.exists) dir.create({ idempotent: true, intermediates: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    file = new File(dir, `session-${stamp}.log`);
    file.create({ overwrite: true });
  } catch (e) {
    console.warn('[SessionLog] could not create the log file', e);
    return;
  }

  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      buffer.push(`${new Date().toISOString()} ${level.toUpperCase()} ${args.map(stringify).join(' ')}`);
    };
  }
  setInterval(flush, FLUSH_MS);
  installed = true;
  global.__eyeauthSessionLog = true;
  console.log(`[SessionLog] writing to ${file.uri}`);
}

/** File only - not printed to Metro. */
export function writeToLogFile(line) {
  if (!installed) {
    console.log(line);
    return;
  }
  buffer.push(`${new Date().toISOString()} DATA ${line}`);
}

/** Opens the iOS share sheet with the current session's log file. */
export async function shareSessionLog() {
  flush();
  if (!file?.exists) throw new Error('Δεν υπάρχει αρχείο log για αυτή τη συνεδρία.');
  return Share.share({ url: file.uri, title: file.name });
}
