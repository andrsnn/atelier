export const meta = {
  name: 'qa-recording',
  description: 'Record a walkthrough of a feature, then have a multimodal model watch the video and judge whether it actually works — a screenshot is not enough for motion.',
  whenToUse: 'Visual QA where behavior/motion matters (an animation, a transition, a live-updating value) and a still frame can not prove it.',
  phases: [
    { title: 'Drive', detail: 'Drive the running app through the feature end-to-end and record a walkthrough video.' },
    { title: 'Inspect', detail: 'A multimodal model watches the recording and reports, moment by moment, what actually happened.' },
    { title: 'Verdict', detail: 'Decide PASS / FAIL from the inspection and write it up.' },
  ],
}

phase('Drive')
const rec = await agent('Start the app, drive the feature end-to-end, and save a walkthrough video of the result.', { label: 'record', schema: RECORDING })

phase('Inspect')
// This phase pins a MULTIMODAL model to actually watch the video output — the pattern
// this whole workflow exists to support. It runs isolated from the main thread.
const inspection = await agent(
  `Watch the recording at ${rec.path} and describe, moment by moment, what happens on screen. Did the feature actually work, or is it a stub / a frozen frame?`,
  { label: 'inspect-video', model: 'claude:opus', schema: INSPECTION },
)

phase('Verdict')
const verdict = await agent(`From the inspection, decide PASS or FAIL with concrete reasons.`, { label: 'verdict' })
return verdict
