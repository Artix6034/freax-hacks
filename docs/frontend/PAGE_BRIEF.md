# Freax CQA workbench

Project stage: existing working prototype; polish and local restructuring, no framework rewrite.
Core users: quality analyst and appeal reviewer.
Business objects: conversation, checklist version, assessment, evidence, appeal, batch.
Surface: enterprise operations workbench, with transcript and assessment as the primary detail view.
Journey: import → select dialogue and checklist → evaluate → inspect cited messages → appeal → review → export.
First decision: choose a source dialogue; success means a saved, evidenced assessment or an honest partial/error.
Recovery: retain input after failure; preserve known criteria; resume a batch without re-evaluating finished attempts.
Information priority: conversation identity and state, transcript, criterion decisions/evidence, then technical metadata.
Mobile task: choose a dialogue, run or inspect assessment; transcript/result tabs replace side-by-side columns.
Foundation: semantic HTML, native controls/dialogs, existing JavaScript modules; no frontend framework dependency.
References: organizer brand materials, Freedom homepage for visual reference only, Microsoft Fluent for enterprise behavior.
Vocabulary: Диалоги, Чек-лист, Оценка, Источники, Пересмотр, Выгрузка.
Keep prompt/schema hashes, billing notes and implementation explanations out of the interface. Do not add compatibility-success panels, disclaimers, introductory hints or explanatory footnotes. Use short labels for actions and actual states. Show a brief error only when it explains a blocked action. Assessment reasoning, quotes and review decisions are product content and stay visible.
Risks: raw JSON dominating entry; enormous all-in-one setup; stacked cards; long IDs/quotes; ambiguous N/A vs unknown.
Verification: real browser at 1440/1024/768/375 and landscape, keyboard/focus, reduced motion, 200% text, import/history/evidence/appeal/editor/export.

## Visual direction

Use Freedom's green as the brand signature in a calm operational interface. Avoid copying the marketing hero, financial claims or decorative glow into the analyst workflow.

Palette: ink #17251E; brand #008F46; interaction #006B37; canvas #F5F7F5; surface #FFFFFF; divider #DCE4DE. Amber and red indicate uncertainty and violations with text labels.
Type: locally served Manrope with Cyrillic extension, with system sans-serif fallback. Tabular figures for scores and weights. Body 14–16px, headings 20–28px.
Layout: slim labelled navigation; compact context toolbar; selectable dialogue list; transcript/assessment workspace. Secondary configuration and history are separate views.
Principle: the evidence is the distinctive element. Every assessment should lead directly to a source message, rather than decorative dashboard statistics.

Desktop sketch:

```text
Navigation | Dialogues / current checklist                  Import
           | Conversation list | Transcript | Assessment / evidence
           |                   | original   | decision + review
```

Two alternatives were considered: a marketing-like green hero (poor fit for repeated analyst work), and a dense monochrome CRM table (loses transcript context). Use the evidence workbench with restrained Freedom accents.

The skill search's hero/CTA recommendation was off-topic; a narrower product lookup found no verified match. Product layout decisions above are an explicit project-specific fallback, not a blindly persisted search result.
