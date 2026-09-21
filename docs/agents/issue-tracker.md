# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues in `sheeyang/poker-app`. Use `gh-axi` for all operations.

Invoke it through `npx -y gh-axi`. Run commands inside this clone to target the current repository, or pass `-R sheeyang/poker-app` explicitly.

Before relying on stored command syntax, consult the installed interface:

- Global help: `npx -y gh-axi --help`
- Issue help: `npx -y gh-axi issue --help`
- Pull-request help: `npx -y gh-axi pr --help`
- API help: `npx -y gh-axi api --help`

## Conventions

- **Create an issue**: `npx -y gh-axi issue create --title "..." --body-file <path>`
- **Read an issue**: `npx -y gh-axi issue view <number> --comments --full`
- **List issues**: `npx -y gh-axi issue list --state open --fields number,title,body,labels,comments`, adding `--label`, `--assignee`, or other filters as needed.
- **Comment on an issue**: `npx -y gh-axi issue comment <number> --body-file <path>`
- **Apply or remove labels**: `npx -y gh-axi issue edit <number> --add-label "..."` or `--remove-label "..."`
- **Close an issue**: `npx -y gh-axi issue close <number> --reason completed --comment "..."`
- **Manage labels**: use `npx -y gh-axi label <subcommand>`

Prefer `--body-file` for multiline bodies and comments.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues:

- **Read a PR**: `npx -y gh-axi pr view <number> --comments --full`
- **Read its diff**: `npx -y gh-axi pr diff <number> --full`
- **List external PRs**: `npx -y gh-axi pr list --state open --fields number,title,body,labels,author,authorAssociation,comments`, keeping only `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE`.
- **Comment, label, or close**: use `gh-axi pr comment`, `gh-axi pr edit`, and `gh-axi pr close`.

GitHub shares one number space across issues and PRs. For a bare `#42`, try `npx -y gh-axi pr view 42`; if it is not a PR, use `npx -y gh-axi issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue with `npx -y gh-axi issue create`.

## When a skill says "fetch the relevant ticket"

Run `npx -y gh-axi issue view <number> --comments --full`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: create one issue labelled `wayfinder:map`, holding the Notes, Decisions-so-far, and Fog sections.
- **Child ticket**: link it with `npx -y gh-axi issue subissue add <map> <child>`. Where sub-issues are unavailable, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body.
- **Blocking**: use GitHub's native issue dependencies through `gh-axi api`. Where dependencies are unavailable, add a `Blocked by: #<n>` line to the child body.
- **Frontier query**: list the map's open children with `npx -y gh-axi issue subissue list <map>`, then choose the first unblocked and unassigned child in map order.
- **Claim**: `npx -y gh-axi issue edit <number> --add-assignee @me`
- **Resolve**: comment with the answer, close the child, then add a context pointer to the map's Decisions-so-far.
