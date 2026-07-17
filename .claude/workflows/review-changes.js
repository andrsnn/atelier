export const meta = {
  name: 'review-changes',
  description: 'Review the current branch across several dimensions, then adversarially verify each finding before reporting.',
  whenToUse: 'Before opening a PR, to catch correctness/security/perf issues with a second opinion on each.',
  phases: [
    { title: 'Scope', detail: 'List the changed files and group them by subsystem.' },
    { title: 'Review', detail: 'One reviewer per dimension reads the diff in parallel.' },
    { title: 'Verify', detail: 'Each finding is independently checked by a skeptic that tries to refute it.' },
    { title: 'Report', detail: 'Synthesize the surviving findings into a ranked review.' },
  ],
}

const DIMENSIONS = [
  { key: 'correctness', prompt: 'Review the diff for logic bugs and broken edge cases.' },
  { key: 'security', prompt: 'Review the diff for injection, authz, and secret-handling issues.' },
  { key: 'performance', prompt: 'Review the diff for N+1 queries, accidental O(n^2), and blocking I/O.' },
]

phase('Scope')
const files = await agent('List changed files vs the base branch and group by subsystem.', { label: 'scope', schema: FILES })

phase('Review')
const reviews = await parallel(
  DIMENSIONS.map((d) => () =>
    agent(`${d.prompt}\n\nChanged files:\n${files.list}`, { label: `review:${d.key}`, schema: FINDINGS }))
)

phase('Verify')
const verified = await pipeline(
  reviews.flatMap((r) => r.findings),
  (f) => agent(`Try to refute this finding. Default to refuted=true if unsure: ${f.summary}`, { label: `verify:${f.file}`, schema: VERDICT }),
)

phase('Report')
const report = await agent(`Synthesize the surviving findings into a ranked review.`, { label: 'synthesize' })
return report
