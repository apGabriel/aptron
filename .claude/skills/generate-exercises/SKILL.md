---
name: generate-exercises
description: Regenerate js/exercises-data.json (the Routine Builder exercise catalog) from a folder of ExerciseDB-convention GIF files using scripts/generate-exercises.js. Triggered by the user.
disable-model-invocation: true
---

Regenerate the exercise catalog consumed by the gym Routine Builder.

The generator scans GIFs named `{id}-{Exercise-Name}_{bodyPart}_{res}.gif` and
writes `js/exercises-data.json`, with `gifUrl` pointing at the Supabase
`exercises` storage bucket.

## Run it

`$ARGUMENTS` should provide the Supabase project ref and the GIF source. Map them
to flags (see `scripts/generate-exercises.js` header for the full list):

```
node scripts/generate-exercises.js --supabase <PROJECT_REF> --dir "<path-to-gifs>"
```

Common variants:
- `--list names.txt` instead of `--dir` when the GIFs live only in Supabase and
  you have an exported filename list.
- `--bucket <name>` (default `exercises`), `--out <path>` (default
  `js/exercises-data.json`).

If the user didn't give a project ref, check `SUPABASE_PROJECT_REF` in the env or
ask. After running, report how many exercises were written and confirm
`js/exercises-data.json` changed. Never hand-edit that JSON — it's generated.
