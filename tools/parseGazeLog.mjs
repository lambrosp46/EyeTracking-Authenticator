#!/usr/bin/env node
/**
 * Turns session logs into JSON for offline analysis / replay.
 *
 *   node tools/parseGazeLog.mjs session-….log [more.log …] > data.json
 *
 * Output: { calibrations: [...], streams: [...] }
 *   calibrations[i] = { file, meta, samples: [{sx, sy, targetX, targetY, targetIndex, headZCm, …}] }
 *                     ([CalibrationData], written by CalibrationOverlay)
 *   streams[i]      = { file, id, meta, samples: [{timestamp, valid, locked, sx, sy, fx, fy, x, y, …}],
 *                       events: [{type, t, …}], end, calibrationAt }
 *                     ([GazeStream], written by useGazeTracker while a login /
 *                     registration gaze screen is open)
 * `calibrationAt` links a stream to the calibration it ran on (the last one
 * before it in the same file). Event `t` is on the same clock as the samples'
 * `timestamp`, so events can be placed exactly in the stream.
 */
import fs from 'node:fs';
import path from 'node:path';

const toObjects = (keys, rows) => rows.map((r) => Object.fromEntries(keys.map((k, j) => [k, r[j]])));

export function parseLog(text, file = '') {
  const calibrations = [];
  const streams = new Map();
  let cal = null;
  let lastCalAt = null;
  for (const line of text.split('\n')) {
    let i = line.indexOf('[CalibrationData] ');
    if (i >= 0) {
      const rest = line.slice(i + 18);
      if (rest.startsWith('meta ')) {
        const meta = JSON.parse(rest.slice(5));
        cal = { file, meta, rows: [] };
      } else if (rest.startsWith('rows ') && cal) {
        cal.rows.push(...JSON.parse(rest.slice(rest.indexOf(' ', 5) + 1)));
      } else if (rest.startsWith('end') && cal) {
        calibrations.push({ file, meta: cal.meta, samples: toObjects(cal.meta.keys, cal.rows) });
        lastCalAt = cal.meta.at;
        cal = null;
      }
      continue;
    }
    i = line.indexOf('[GazeStream] ');
    if (i < 0) continue;
    const m = line.slice(i + 13).match(/^(\w+) (\S+) (.*)$/);
    if (!m) continue;
    const [, kind, id, json] = m;
    const data = JSON.parse(json);
    if (kind === 'start') {
      // Older builds restarted the id counter on every screen: an id seen
      // before starts a new stream (the earlier one keeps its own key).
      if (streams.has(id)) streams.set(`${id}@${streams.get(id).meta.at}`, streams.get(id));
      streams.set(id, { file, id, meta: data, rows: [], events: [], end: null, calibrationAt: lastCalAt });
      continue;
    }
    const st = streams.get(id);
    if (!st) continue;
    if (kind === 'rows') st.rows.push(...data);
    else if (kind === 'event') st.events.push(data);
    else if (kind === 'end') st.end = data;
  }
  return {
    calibrations,
    streams: [...streams.values()].map(({ rows, ...st }) => ({ ...st, samples: toObjects(st.meta.keys, rows) })),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = { calibrations: [], streams: [] };
  for (const f of process.argv.slice(2)) {
    const r = parseLog(fs.readFileSync(f, 'utf8'), path.basename(f));
    out.calibrations.push(...r.calibrations);
    out.streams.push(...r.streams);
  }
  process.stderr.write(
    `${out.calibrations.length} calibrations, ${out.streams.length} gaze streams ` +
      `(${out.streams.reduce((a, s) => a + s.samples.length, 0)} samples, ${out.streams.reduce((a, s) => a + s.events.length, 0)} events)\n`
  );
  process.stdout.write(JSON.stringify(out));
}
