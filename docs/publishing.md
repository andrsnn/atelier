# Publishing

This repo is private. Its public counterpart is a **squashed snapshot** — the
current tracked tree committed once, with no git history. Two pieces make that
safe and repeatable: a readiness gate and a publish script.

## Publish-readiness gate

`npm run readiness` launches the `.claude/workflows/publish-readiness.js` workflow
(headless Claude) to decide whether the repo is safe to make public. It reviews the
tree that would actually ship across nine dimensions:

1. **Secrets** — hardcoded keys/tokens/private keys, connection strings with inline
   credentials, dangerous fallback defaults.
2. **PII** — real names/emails, phone/address, personal handles, absolute local
   paths that embed a username (`/Users/<name>`, `/Volumes/<name>`).
3. **Personal / user data** — committed user content, seed data from real records,
   `.db` dumps, screenshots/recordings showing real data.
4. **Internal URLs & infra** — deployment URLs, admin endpoints, bucket/org/project
   IDs, references back to the private repo.
5. **Security misconfig** — public routes that shouldn't be, missing authz, disabled
   SSRF/TLS checks, wide-open CORS, backdoor/test accounts.
6. **Git-history hygiene** — anything sensitive ever committed (the publish squashes
   history, so the mirror is clean, but leaked credentials still need rotating).
7. **Licensing** — missing `LICENSE`, un-attributed third-party code, `CONFIDENTIAL`
   markers.
8. **Repo hygiene** — `.gitignore` coverage, scratch/internal files about to ship,
   `.env.example` completeness, CI workflow secrets.
9. **Docs & comments** — `TODO`/`FIXME` revealing internals, internal links, names.

Each finding is adversarially verified (a skeptic tries to refute it) so false
positives don't fail the gate. The result is a **PASS/FAIL** verdict plus a report:

- `.publish-readiness/report.md` — human-readable, with next steps to reach PASS.
- `.publish-readiness/latest.json` — machine verdict the publish script reads.
- `.publish-readiness/findings.json` — full findings (drives `readiness:fix`).

`.publish-readiness/` is gitignored; it never ships.

```
npm run readiness            # audit → report → exit 0 (PASS) / 1 (FAIL)
npm run readiness -- --json  # machine-readable verdict
npm run readiness:fix        # apply the mechanical fixes (paths/identifiers/gitignore) and open a PR
```

Judgment-call findings (security, "should this file ship") are reported with a
proposed action, not auto-edited. Only mechanical redactions are auto-fixable.

## Publish

`npm run publish:public`:

1. Runs the readiness gate. A FAIL aborts the publish.
2. Exports the git-tracked tree with `git archive HEAD` — no untracked files, no
   `.git`, no history.
3. Commits that snapshot as a single orphan commit authored by a neutral identity.
4. Force-pushes it to the public remote in `publish.config.json`.

```
npm run publish:public              # gate, then publish
npm run publish:public -- --dry-run # gate + build snapshot, print the file manifest, don't push
npm run publish:public -- --no-gate # skip the gate (not advised)
```

`publish.config.json`:

```json
{
  "publicRemote": "https://github.com/andrsnn/atelier.git",
  "publishBranch": "main",
  "commitAuthorName": "andrsnn",
  "commitAuthorEmail": "andrsnn@users.noreply.github.com",
  "exclude": [".publish-readiness", "atelier.projects.json"]
}
```

If `publicRemote` is `null`, the publish runs the gate and no-ops the upload — used
until a public repo exists.

Authentication uses the `gh` CLI token (`gh auth token`); run `gh auth login` first.
The token is passed to the push and never written to disk.
