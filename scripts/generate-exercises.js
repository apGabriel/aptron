#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Exercise catalog generator
//
// Scans a folder of exercise .gif files (named in the ExerciseDB convention)
// and produces js/exercises-data.json for the Routine Builder.
//
// Filename convention it expects:
//   {numericId}-{Exercise-Name-With-Hyphens}_{bodyPart}_{resolution}.gif
//   e.g.  00071301-Alternate-Lateral-Pulldown_back_720.gif
//         00231301-Barbell-Alternate-Biceps-Curl_Upper-Arms_720.gif
//         42271301-Cable-Lying-Front-Raise_Shoulders_720.gif
//
// Each parsed entry becomes:
//   {
//     "id":          "alternate_lateral_pulldown",
//     "name":        "Alternate Lateral Pulldown",
//     "muscleGroup": "Back",
//     "gifUrl":      "https://<ref>.supabase.co/storage/v1/object/public/exercises/<original-filename>"
//   }
//
// USAGE
//   node scripts/generate-exercises.js --supabase <PROJECT_REF> [options]
//
// OPTIONS
//   --supabase <ref>   Supabase project ref (the xxxx in xxxx.supabase.co).
//                      Or set env SUPABASE_PROJECT_REF.
//   --dir <path>       Folder containing the .gif files. Default: ./gifs
//   --list <file.txt>  Instead of scanning a folder, read filenames (one per
//                      line) from a text file. Handy if your files live only
//                      in Supabase and you exported the names with the CLI.
//   --bucket <name>    Storage bucket name. Default: exercises
//   --out <path>       Output JSON path. Default: js/exercises-data.json
//
// EXAMPLES
//   node scripts/generate-exercises.js --supabase abcd1234 --dir "C:\gifs"
//   node scripts/generate-exercises.js --supabase abcd1234 --list names.txt
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Body-part → muscle group mapping ──────────────────────────────────────────
// Keys are normalized to lower-case (so "Upper-Arms", "upper-arms" both match).
// Includes the messy real-world variants found across the 745 source files:
// plural/singular, "-FIX"/"-SFIX"/"-AFIX" suffixes, and typos (e.g. "Wiast").
const MUSCLE_MAP = {
  // Back
  'back':           'Back',
  'back-fix':       'Back',

  // Chest
  'chest':          'Chest',
  'chest-fix':      'Chest',

  // Shoulders
  'shoulders':      'Shoulders',
  'shoulder':       'Shoulders',
  'shoulder-afix':  'Shoulders',

  // Arms (upper + lower arms, forearms, triceps)
  'upper-arms':     'Arms',
  'upper-arms-fix': 'Arms',
  'lower-arms':     'Arms',
  'forearm':        'Arms',
  'forearms':       'Arms',
  'forearm-sfix':   'Arms',
  'triceps':        'Arms',
  'triceps-sfix':   'Arms',

  // Legs (upper + lower legs, calves, thighs, hips)
  'upper-legs':     'Legs',
  'lower-legs':     'Legs',
  'calf':           'Legs',
  'calves':         'Legs',
  'thighs':         'Legs',
  'thighs-fix':     'Legs',
  'hip':            'Legs',
  'hips':           'Legs',
  'hips-fix':       'Legs',

  // Core / Abs
  'waist':          'Core/Abs',
  'waist-fix':      'Core/Abs',
  'wiast':          'Core/Abs',   // common typo in source set

  // Neck
  'neck':           'Neck',

  // Cardio
  'cardio':         'Cardio',
  'cardio-fix':     'Cardio',
  'plyometric':     'Cardio',

  // Other / catch-all
  'hands':          'Other',
  'fix':            'Other',
};

// A few source files are missing the body-part segment entirely
// ({id}-{Name}_{res}.gif). Force their muscle group by exact filename.
const FORCED_BY_FILENAME = {
  '12231301-Underhand-Grip-Inverted-Back-Row_720.gif': 'Back',
  '32901301-Weighted-One-Hand-Pull-up_720.gif':        'Back',
  '34481301-Dumbbell-Side-Lunge-VERSION-3_720.gif':    'Legs',
};

// ── CLI args ──────────────────────────────────────────────────────────────────
function getArg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SUPABASE_REF = getArg('supabase', process.env.SUPABASE_PROJECT_REF || '');
const BUCKET       = getArg('bucket', 'exercises');
const GIF_DIR      = getArg('dir', 'gifs');
const LIST_FILE    = getArg('list', '');
const OUT_PATH     = getArg('out', path.join('js', 'exercises-data.json'));

if (!SUPABASE_REF) {
  console.error('\nERROR: Supabase project ref is required.');
  console.error('  Pass --supabase <ref> or set SUPABASE_PROJECT_REF.');
  console.error('  (It is the "xxxx" in https://xxxx.supabase.co)\n');
  process.exit(1);
}

const PUBLIC_BASE = `https://${SUPABASE_REF}.supabase.co/storage/v1/object/public/${BUCKET}/`;

// ── Collect filenames (from a folder or a text list) ──────────────────────────
function collectFilenames() {
  if (LIST_FILE) {
    if (!fs.existsSync(LIST_FILE)) {
      console.error(`ERROR: list file not found: ${LIST_FILE}`);
      process.exit(1);
    }
    return fs.readFileSync(LIST_FILE, 'utf8')
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => path.basename(s)); // tolerate full paths in the list
  }

  if (!fs.existsSync(GIF_DIR)) {
    console.error(`ERROR: directory not found: ${GIF_DIR}`);
    console.error('  Pass --dir <path> to point at your .gif folder, or --list <file.txt>.');
    process.exit(1);
  }
  return fs.readdirSync(GIF_DIR).filter(f => f.toLowerCase().endsWith('.gif'));
}

// ── Parse one filename into a catalog entry ───────────────────────────────────
function parseFilename(filename) {
  const forced = FORCED_BY_FILENAME[filename];
  const base   = filename.replace(/\.gif$/i, '');

  // Segments are underscore-delimited: <id-and-name>_<bodyPart>_<resolution>
  // The body part itself may contain hyphens ("Upper-Arms") but never an
  // underscore, so splitting on "_" is safe. Resolution is the last segment.
  const segments = base.split('_');

  let bodyPart, namePart;
  if (forced) {
    // These files omit the body-part segment: {id}-{Name}_{resolution}.gif
    segments.pop();                    // drop resolution (e.g. "720")
    namePart = segments.join('_');
    bodyPart = null;                   // muscle comes from the forced override
  } else {
    if (segments.length < 3) {
      return { error: `unexpected name shape (need id_bodypart_res): ${filename}` };
    }
    segments.pop();                    // drop resolution (e.g. "720")
    bodyPart = segments.pop();         // e.g. "back" / "Upper-Arms"
    namePart = segments.join('_');     // e.g. "00071301-Alternate-Lateral-Pulldown"
  }

  // namePart = "{numericId}-{Word-Word-Word}". First hyphen segment is the id.
  const hyphenParts = namePart.split('-');
  const numericId   = hyphenParts.shift();           // "00071301"
  const words       = hyphenParts.filter(Boolean);   // ["Alternate","Lateral","Pulldown"]

  if (!words.length) {
    return { error: `could not extract a name from: ${filename}` };
  }

  const name = words.join(' ');
  const id   = words.join('_').toLowerCase().replace(/[^a-z0-9_]/g, '');

  let muscleGroup, unmappedMuscle = null;
  if (forced) {
    muscleGroup = forced;
  } else {
    muscleGroup = MUSCLE_MAP[bodyPart.toLowerCase()];
    if (!muscleGroup) { unmappedMuscle = bodyPart; muscleGroup = titleCase(bodyPart); }
  }

  return {
    entry: {
      id,
      name,
      muscleGroup,
      gifUrl: PUBLIC_BASE + encodeURIComponent(filename),
    },
    unmappedMuscle,
    numericId,
  };
}

function titleCase(s) {
  return s.split(/[-\s]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  const files = collectFilenames();
  if (!files.length) {
    console.error('No .gif files found. Nothing to do.');
    process.exit(1);
  }

  const entries   = [];
  const seenIds   = new Map();   // id -> count, for de-duping
  const errors    = [];
  const unmapped  = new Set();

  for (const file of files) {
    const result = parseFilename(file);
    if (result.error) { errors.push(result.error); continue; }
    if (result.unmappedMuscle) unmapped.add(result.unmappedMuscle);

    let id = result.entry.id;
    if (seenIds.has(id)) {
      const n = seenIds.get(id) + 1;
      seenIds.set(id, n);
      id = `${id}_${n}`;          // keep ids unique
      result.entry.id = id;
    } else {
      seenIds.set(id, 1);
    }
    entries.push(result.entry);
  }

  // Sort by muscle group, then name — nice and stable for the builder UI.
  entries.sort((a, b) =>
    a.muscleGroup.localeCompare(b.muscleGroup) || a.name.localeCompare(b.name));

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(entries, null, 2) + '\n', 'utf8');

  // ── Report ──
  console.log(`\n✓ Wrote ${entries.length} exercises → ${OUT_PATH}`);
  const byGroup = entries.reduce((m, e) => (m[e.muscleGroup] = (m[e.muscleGroup] || 0) + 1, m), {});
  console.log('  By muscle group:');
  Object.keys(byGroup).sort().forEach(g => console.log(`    ${g.padEnd(12)} ${byGroup[g]}`));

  if (unmapped.size) {
    console.log('\n⚠ Unmapped body parts (title-cased as a fallback — add them to MUSCLE_MAP if needed):');
    [...unmapped].sort().forEach(m => console.log(`    "${m}"`));
  }
  if (errors.length) {
    console.log(`\n⚠ ${errors.length} file(s) could not be parsed:`);
    errors.slice(0, 20).forEach(e => console.log('    ' + e));
    if (errors.length > 20) console.log(`    …and ${errors.length - 20} more`);
  }
  console.log('');
}

main();
