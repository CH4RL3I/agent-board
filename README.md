# agent-board

A [Claude Code](https://claude.com/claude-code) mod that draws small animated pixel sprites above the prompt: one for each subagent or teammate of the current session, and one for each of your other Claude sessions that is busy or waiting. You see at a glance who is working and who needs you.


## What it shows

Each sprite has a label and a state line underneath:

| State | Meaning | Look |
| --- | --- | --- |
| working | busy right now | sprite bobs up and down, blue label |
| waiting for you | idle, your turn | yellow label and a yellow corner mark |
| done | finished (stays for one minute) | dimmed sprite, green mark |
| failed | failed or killed (stays for one minute) | red mark |

Sprite types:

- **conductor**: this session, shown while it has subagents or teammates
- **builder**: a subagent
- **scout**: a read-only style subagent (explore, plan, guide, review, validator types)
- **mate**: a teammate
- **session**: another Claude Code CLI session running on your machine

Sessions that have been idle for more than 30 minutes are not drawn, only counted ("N other sessions idle"). If the row does not fit your terminal width, the rest is counted as "+N more on the board".

## Install

In a Claude Code terminal session:

```
/plugin install agent-board --marketplace CH4RL3I/agent-board
```

Answer `y` to add the marketplace, then pick a scope.

## Use

- `/agent-board` toggles the board on and off.
- Optional setting `extraSessionDirs` (in `/config`): comma-separated extra directories that hold Claude session files. Useful if you keep sessions somewhere unusual. `~/.claude/sessions` and every `~/.claude-*/sessions` (for example a second profile with its own config dir) are scanned automatically.

## How it reads sessions

- Subagents and teammates of the current session come from Claude Code's own agent list.
- Other sessions are found by reading the JSON files in `~/.claude/sessions` (and the other directories above), then checking with `ps` that the process is still alive.
- Everything is local. The mod makes no network requests and writes nothing to disk. It only reads session files and runs `ps`.
- The label is the session's name if it has one, else its tmux session name, else its working directory's folder name. Labels are shown only in your own terminal.

## Requirements

- Claude Code with mod support (hooks modules, `claude plugin` commands).
- The terminal surface. The board is drawn with half-block characters and a raster element; other surfaces (desktop, IDE) show nothing.
- `ps` on the PATH (macOS or Linux).

## Limits

- Session files are an internal Claude Code format; a future release may change them and break detection of other sessions.
- Only CLI sessions (`entrypoint: cli`) are listed.
- At most 8 sprites are drawn, fewer on narrow terminals.
- The board refreshes every 3 seconds; the bob animation runs at about 3 frames per second.

## Develop

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## License

MIT, see [LICENSE](LICENSE).
