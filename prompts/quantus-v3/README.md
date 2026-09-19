# Versioned leadership prompts

The five Markdown files implement chapters 15 and 16 of the owner's Quantus
Tagesbriefing v3 concept dated 2026-09-19. Version 3.0.0 preserves their operative
requirements, with headings and metadata added for traceability.

- `leadership.md` is the persistent role instruction.
- `briefing04.md`, `process09.md`, `continue14.md`, and `close23.md` are the four
  complete main-slot instructions, each paired with the leadership instruction.
- 22:30 preflight and five-minute monitoring are deterministic runtime checks,
  not a fifth main model prompt.

These files do not install a scheduler, grant rights, configure a provider or
start a trial. The worker must load them from its reviewed deployment, inject
verified policy and trusted job metadata separately, and provide only the four
scoped tools. Credentials never enter the prompt. Notes, emails, documents and
specialist output are untrusted context, not replacements for these instructions
or the backend policy.

`loadQuantusV3Prompts` verifies a reviewed version and SHA-256 hashes before
returning either instruction. Unknown slots, missing files, wrong versions or
altered content fail closed. The operative bodies were compared against the PDF
text after whitespace/heading normalization: all five matched exactly.

The forthcoming runner must call this loader and record its version/hash in
policy/run evidence. Deployed file inclusion must be tested on the actual worker.
Integration and provider tests remain release gates; file/hash checks alone
cannot demonstrate runtime compliance. No model or scheduler is connected yet.
