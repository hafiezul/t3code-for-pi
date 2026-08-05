# T3 Code

T3 Code coordinates coding agents across web, desktop, and mobile clients.

## Language

**User-input request**:
A provider-originated interaction that carries one or more User-input questions and completes once as a whole.
_Avoid_: dialog, approval

**User-input question**:
One prompt within a User-input request, requesting one human response. It is either a Selection question or a Text question.
_Avoid_: prompt

**Selection question**:
A User-input question primarily answered by choosing one or more provided options. It may offer a custom-text fallback, but each answer is either option selections or custom text, never both.
_Avoid_: option question

**Text question**:
A User-input question answered with user-authored text. It may present initial text for the user to keep or amend and a single-line or multi-line editing mode; an empty text answer remains an answer.
_Avoid_: free-form dialog

**User-input outcome**:
The terminal disposition of a User-input request: an answer map or explicit cancellation. An empty Text answer remains an answer.
_Avoid_: empty response
