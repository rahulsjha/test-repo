# Guest desk: review and improve an AI draft

A fictional hospitality team uses this inbox. The Handle next feature is an AI-generated draft that has not passed review. Use your usual AI coding tool to decide what to keep, what to change, and what to verify.

## Open the workspace

You need Node 22.13 or newer. No install, API key, login or real guest data is needed.

```sh
node --version
npm test
npm start
```

Open http://localhost:43211. The server holds fictional records in memory; restarting resets them. The baseline tests cover the existing inbox, not all requirements of the draft. Passing them is a starting point, not proof that the new feature is correct.

If setup fails, save the exact error. You can submit your plan, a focused proposed diff and a test plan, clearly separating these from checks you ran. You can save the assessment and return later.

## The operator's need

Help an operator choose the next open guest request and mark it handled.

- GET /api/next-request returns an existing open request and a useful reason, or request:null with a reason for an empty queue.
- Order urgency as urgent, normal, low. Within one urgency, use the oldest createdAt, then ascending request ID for an exact tie.
- Resolved requests must never be recommended.
- The browser uses the backend decision, displays its reason and marks the request handled through the existing API before loading the next recommendation.
- Keep existing filters and controls working. Loading, empty and error states must be honest. A failed update must not look successful.

Read the draft before editing. Preserve what works, make focused corrections, add meaningful checks, and choose one small usability improvement that helps the operator. There is no need for authentication, an external AI service, deployment or a persistent database in this exercise.

The assessment may introduce a new requirement after your first submission. Do not solve hypothetical future requirements in advance.

## Your handoff

Use SUBMISSION.md as an outline. Include your decision and reason, a focused diff or reviewer-accessible link, actual command/browser results and remaining gaps. AI assistance is welcome. Full generated drafts are allowed; show how you decided whether to trust the result. If nothing needed changing in a particular suggestion, say so rather than inventing a correction.
# test-repo
