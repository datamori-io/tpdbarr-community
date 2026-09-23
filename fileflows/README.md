# FileFlows flows

Exports from the FileFlows server that encodes scenes before Stash files them.

| File | What it is |
|---|---|
| `07b602a9-….json` | *Porn ReEncoding (transfer)* — HEVC encode, scale to 1080p, 720p or 480p, primary audio |
| `75d54021-….json` | *Porn ReEncoding* — the same flow for the other library |
| `*.patched.json` | the same two with `-movflags +faststart` inserted before every Executor (made by `faststart.py`) |
| `faststart-flow.json` | *Faststart Remux* — rewrites the container only, no re-encode (made by `backfill-flow.py`) |
| `library.patched.json` | a library pointing the remux flow at already-finished scenes |
| `libs.json` | the libraries, for reference — paths are container paths |

Import the flows through FileFlows' own Flows › Import. Library paths will
need changing to match your mounts.
