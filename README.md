# ramzi-claude-mods

Ramzi Rebeiz's mods for Claude Code: plugins of function hooks that change what the Claude
app shows while a session runs. Each mod is a folder here, and this repository is the
marketplace they install from.

## ramzi-panes

Three compact panes, each with a collapse control (▾/▸) in its header and the engine's own
close mark. The desktop app and the phone draw them; a terminal narrower than 110 columns
draws the Activity header above the prompt instead.

| Pane | Opens | Shows |
| --- | --- | --- |
| Activity | by itself at session start; `/activity` | what is running now with its elapsed time, the last calls finished, and a `done` tab: one line per finished turn (time, length, tools, files, commits, pushes), pressed open for the detail. `/done 20` prints the last twenty as text. |
| Branches | `/branches`, or the `branches` button | every git checkout the session can see, each local branch against origin's default branch: green fast-forward, amber behind (sync owed), red diverged from its upstream, grey merged. Press a repo for the lane graph. |
| Files | `/files`, or the `files` button | every checkout's changed files, coloured by the turn that edited them (green the shown turn, amber another); `tree` walks the whole checkout; a press shows the file's diff. ◀ ▶ step the shown turn. |

The git panes read the repos again a moment after any Bash command that names git, and when a
turn ends. ↻ rediscovers the repos.

## Install

At the prompt of a terminal session:

```
/plugin install ramzi-panes --marketplace ramzi-rebeiz/ramzi-claude-mods
```

From a shell (a cloud environment's setup script, say):

```
claude plugin marketplace add ramzi-rebeiz/ramzi-claude-mods
claude plugin install ramzi-panes@ramzi-claude-mods
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins,
Add marketplace with `ramzi-rebeiz/ramzi-claude-mods`, then Add plugin.

## Working on a mod

`claude plugin validate <mod>` reads the manifest and the hooks module the way the engine
will; `claude plugin test <mod>` runs its `tests/*.test.tsx` against the engine itself.
