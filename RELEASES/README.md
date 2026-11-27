# Release records

One record per release tag, written by `scripts/release-record.mjs` from the
tag itself and from the files the game pages served when it was made.

| File | What it holds |
|---|---|
| `<tag>.json` | The release record: the tag, commit and tree; the SHA-256 of the source archive; the licences; where the build steps are; the version string inside each served core; and every file served at `/room-seat` and `/pilot` with its SHA-256 and the source file it comes from |
| `<tag>.sha256` | One `<sha256>  <path>` line for every file in the tag, as stored in Git |

## Source availability

Each release of the Derby Owners Club browser game includes free software under
the licences in `LICENSE`, `COPYRIGHT` and `THIRD_PARTY_NOTICES.md`. The complete
corresponding source of the GPL covered parts, with the scripts that build and
link the cores, is this repository at the release tag named in the record
(`https://github.com/Indigenous-Healthcare-Advancements/doc-browser-source/tree/<tag>`).
The record gives the exact versions and checksums. No game files are included:
the player supplies them. Source questions: open an issue on this repository.

Project policy: every release tag and its record stay public indefinitely, and
never less than three years after the release was last served.

## Checking a release

Unpack the tag and check every file against the list:

    git -c core.autocrlf=false -c core.eol=lf archive --format=tar <tag> | tar -x -C <empty folder>
    cd <empty folder> && sha256sum -c <this folder>/<tag>.sha256

The same `git archive` command gives the archive SHA-256 in the record (with the
Git version named there). The zip GitHub offers is made by GitHub and is not
hashed; its files check against the list in the same way.

Check the record against the tag, and the served files against a deploy:

    node scripts/release-record.mjs --check RELEASES/<tag>.json [--room-seat <doc-arcade>/room-assets] [--pilot <doc-arcade>/pilot-assets]

## Making a record

From a checkout that has the tag, after the deploy that serves it:

    node scripts/release-record.mjs --tag <tag> --repo-url https://github.com/Indigenous-Healthcare-Advancements/doc-browser-source \
      --room-seat <doc-arcade>/room-assets --pilot <doc-arcade>/pilot-assets \
      --built "room-seat=<how the seat core was built>" --built "pilot=<how the pilot cores were built>"

Served files are compared with their source by content. "Same apart from line
ends" means only CRLF against LF differs; "same after the import paths of
SOURCE.md section 1" is the pilot's lb module move. Any "DIFFERS" or "not in
the tag" means the source of that file is not published at this tag and must be
before the page is served.

## Records

- `web-2026.11.26-1`: recorded 2026-11-26 from the production deploy of that
  day. 147 source files. `/room-seat`: the page, 54 modules and the room seat
  core, all matching the tag. `/pilot`: 33 modules, all matching the tag, and
  the two cores of release `web-2026.11.05-1`. Earlier tags have no record.
