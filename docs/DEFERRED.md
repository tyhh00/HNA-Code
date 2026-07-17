# Deferred ideas

Things we want to build later, captured so we do not lose them.

## Focused Mode

A mode for when you want to step away from the grid and work in another app (browser, editor)
but still get pulled back the instant a Claude session needs you.

Rough shape:
- **Spotify / audio control:** connect to the desktop Spotify app. Play music while you work, and
  duck or pause other audio sources when a session needs attention (or when you enter Focused Mode).
- **Attention popup when unfocused:** when the Claude Windows app is not the focused window and a
  session raises a question (an `ask_user_question` / permission / idle event), surface a small
  always-on-top popup for just that one session. It shows the question and lets you answer inline,
  in a compact "playback-style" render, without switching back to the full grid.
- Net effect: you can browse the web or code elsewhere, and the one session that needs you pops up
  in your face for a quick answer, then gets out of the way.

Open questions:
- Spotify integration surface (Web API with OAuth vs local desktop control).
- Which Claude Code events map to "needs you" (Notification `permission_prompt`, `idle_prompt`,
  and any future `ask_user_question` hook).
- How to render an inline answer box that can send input back into the right PTY.
- Always-on-top popup vs OS notification with inline reply.

## Other parked ideas

- Pinned / stateful dev-server ports per cell (one-click start a repo's localhost on a fixed port).
  Needs a clearer spec: is it a per-cell startup command, a port reservation, or both?
