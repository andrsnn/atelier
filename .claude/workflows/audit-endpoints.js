export const meta = {
  name: 'audit-endpoints',
  description: 'Sweep every API route for missing auth checks, looping until two consecutive passes find nothing new.',
  whenToUse: 'Security audit of a web app before launch.',
  phases: [
    { title: 'Discover', detail: 'Enumerate every route handler in the codebase.' },
    { title: 'Audit', detail: 'Inspect each route for an auth/authorization check, one agent per route.' },
    { title: 'Confirm', detail: 'Re-check flagged routes until a round surfaces nothing new.' },
  ],
}

phase('Discover')
const routes = await agent('Find every API route handler under app/api and list its path + methods.', { label: 'discover', schema: ROUTES })

phase('Audit')
const findings = await pipeline(
  routes.list,
  (route) => agent(`Does ${route.path} verify the caller is authorized before acting? Report any gap.`, { label: `audit:${route.path}`, schema: GAP }),
)

phase('Confirm')
const flagged = findings.filter((f) => f.gap)
let dry = 0
while (dry < 2) {
  const recheck = await parallel(
    flagged.map((f) => () => agent(`Re-verify the missing-auth gap on ${f.path}. Is it real?`, { label: `confirm:${f.path}`, schema: GAP })),
  )
  const stillReal = recheck.filter((r) => r.gap)
  if (stillReal.length === flagged.length) dry++
  else dry = 0
  log(`confirm round: ${stillReal.length}/${flagged.length} still flagged`)
}
return flagged
