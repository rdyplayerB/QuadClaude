# Product Requirements Document: QuadClaude - Multi-Terminal Claude Workspace

**Document Version:** 1.1
**Date:** January 23, 2026
**Status:** Draft

---

## Executive Summary

QuadClaude is a desktop application that enables users to run four simultaneous Claude terminal sessions within a single unified window. Inspired by video conferencing layouts (like Zoom), users can dynamically switch between view configurations to optimize their workflow. All terminal panes resize proportionally with the main application window, providing a seamless multi-session Claude experience.

This application addresses the growing need for power users who work with multiple Claude instances simultaneously—whether for parallel task execution, comparative analysis, or managing distinct project contexts.

---

## Problem Statement

### Current Pain Points

1. **Window Management Overhead**: Users running multiple Claude terminal sessions must manually manage separate windows, leading to desktop clutter and constant alt-tabbing.

2. **Inconsistent Sizing**: When resizing the desktop or switching displays, individual terminal windows don't resize cohesively, breaking workflow continuity.

3. **Context Switching Friction**: Comparing outputs or managing parallel Claude conversations requires manual window arrangement, reducing productivity.

4. **No Unified View**: There's no way to see all Claude sessions at a glance while maintaining the ability to focus on a single session when needed.

### Opportunity

By consolidating four Claude terminal sessions into a single, intelligently-arranged application window, users can:
- Reduce cognitive load from window management
- Maintain visual awareness of all sessions simultaneously
- Quickly switch focus between sessions
- Adapt their workspace layout to match their current task

---

## Objectives

| Objective | Measurable Goal |
|-----------|-----------------|
| **Unified Experience** | Users can launch, view, and interact with 4 Claude terminal sessions from a single application |
| **Dynamic Layouts** | Provide minimum 4 distinct view configurations switchable in < 1 second |
| **Responsive Resizing** | All panes resize proportionally within 16ms (60fps) of window resize events |
| **Session Independence** | Each terminal maintains independent state, history, and context |
| **Quick Adoption** | New users can understand layout controls within 30 seconds without documentation |

---

## User Stories

### Persona 1: The Power Developer (Alex)
> *"I use Claude for coding assistance across multiple projects. I need to keep separate contexts for frontend, backend, testing, and documentation."*

**Stories:**
- As Alex, I want to run 4 independent Claude sessions so that I can maintain separate project contexts without cross-contamination.
- As Alex, I want to maximize one terminal while keeping others visible so that I can focus on active work while monitoring other sessions.
- As Alex, I want all terminals to resize with the app window so that I can quickly move between displays without manual adjustment.

### Persona 2: The Researcher (Jordan)
> *"I compare Claude's responses to similar prompts or test different approaches to the same problem."*

**Stories:**
- As Jordan, I want a 2x2 grid view so that I can compare four responses side-by-side.
- As Jordan, I want to quickly swap which terminal is in the "main" position so that I can promote interesting results to focus view.
- As Jordan, I want each session to maintain its own history so that I can scroll back through different conversation threads.

### Persona 3: The Multitasker (Sam)
> *"I juggle multiple tasks throughout the day and need quick access to different Claude conversations."*

**Stories:**
- As Sam, I want to switch layouts with a keyboard shortcut so that I can adapt my view without reaching for the mouse.
- As Sam, I want visual indicators showing which terminal is active so that I always know where my input will go.
- As Sam, I want to name/label each terminal pane so that I can quickly identify session purposes.

### Persona 4: The Project Switcher (Morgan)
> *"I work on different projects throughout the week and need my workspace to remember where I left off."*

**Stories:**
- As Morgan, I want terminals to start as regular shells so that I can navigate to my project folder before starting Claude.
- As Morgan, I want the app to remember which folders each terminal was in so that when I reopen the app, I'm back where I left off.
- As Morgan, I want the option to auto-start Claude in my saved directories so that I can jump right back into work (Warm Start).
- As Morgan, I want exiting Claude to return me to a shell (not close the pane) so that I can start a new Claude session or navigate elsewhere.
- As Morgan, I want to see at a glance which panes have Claude running vs. just a shell so that I know the state of my workspace.

---

## Functional Requirements

### FR-1: Multi-Terminal Display
| ID | Requirement | Priority |
|----|-------------|----------|
| FR-1.1 | Application shall display exactly 4 terminal panes simultaneously | Must Have |
| FR-1.2 | Each pane shall run an independent shell session (bash/zsh based on user's default) | Must Have |
| FR-1.3 | Each pane shall maintain independent scroll position and command history | Must Have |
| FR-1.4 | Panes shall be visually distinguished with borders or subtle separators | Must Have |
| FR-1.5 | Users shall be able to assign custom labels to each pane | Should Have |
| FR-1.6 | All 4 panes shall always be present—no pane shall ever be "closed" or empty | Must Have |

### FR-2: Layout Configurations
| ID | Requirement | Priority |
|----|-------------|----------|
| FR-2.1 | **Grid View (2x2)**: All 4 panes displayed in equal quadrants | Must Have |
| FR-2.2 | **Focus View**: 1 large pane (75%) + 3 small panes (25% stacked) | Must Have |
| FR-2.3 | **Split View**: 2 panes side-by-side (50/50), other 2 hidden/tabbed | Should Have |
| FR-2.4 | **Horizontal Stack**: 4 panes in a single horizontal row | Should Have |
| FR-2.5 | **Vertical Stack**: 4 panes in a single vertical column | Should Have |
| FR-2.6 | Users shall be able to select which pane is "primary" in Focus View | Must Have |
| FR-2.7 | Layout switching shall occur without interrupting active sessions | Must Have |

### FR-3: Responsive Resizing
| ID | Requirement | Priority |
|----|-------------|----------|
| FR-3.1 | All panes shall resize proportionally when application window is resized | Must Have |
| FR-3.2 | Minimum pane dimensions shall be enforced to maintain usability | Must Have |
| FR-3.3 | Text within terminals shall reflow appropriately on resize | Must Have |
| FR-3.4 | Application shall remember window size/position between sessions | Should Have |

### FR-4: Terminal Lifecycle & Initial State
| ID | Requirement | Priority |
|----|-------------|----------|
| FR-4.1 | Each pane shall start as a **standard shell** (bash/zsh), NOT auto-launching Claude | Must Have |
| FR-4.2 | Users shall manually navigate (`cd`) and invoke `claude` when ready | Must Have |
| FR-4.3 | Panes shall never be empty—always display an active shell | Must Have |
| FR-4.4 | When Claude session exits (user types `/exit`, Ctrl+C, or crash), pane shall reset to a fresh shell in the same working directory | Must Have |
| FR-4.5 | Pane shall display visual state indicator showing current mode (see State Indicators below) | Must Have |
| FR-4.6 | Users shall be able to manually reset any pane to a fresh shell via menu/shortcut | Should Have |

#### Terminal State Indicators
Each pane header/border shall indicate its current state:
- **Shell** (neutral) - Standard terminal, Claude not running
- **Claude Active** (highlighted) - Claude CLI is running in this pane
- **Claude Exited** (brief flash/fade) - Transitional state before resetting to Shell

### FR-5: Workspace Persistence ("Memory Snapshot")
| ID | Requirement | Priority |
|----|-------------|----------|
| FR-5.1 | Application shall persist workspace state on quit (see Persisted Data below) | Must Have |
| FR-5.2 | On app launch, application shall restore each pane's working directory | Must Have |
| FR-5.3 | User shall choose restore behavior via preference: **Cold Start** or **Warm Start** | Should Have |
| FR-5.4 | Application shall store workspace snapshots locally (not cloud-synced) | Must Have |
| FR-5.5 | If a previously-saved directory no longer exists, pane shall fall back to user's home directory | Must Have |

#### Persisted Data (per pane)
- Working directory path
- Custom label (if set)
- Whether Claude was active at time of quit
- Pane position in layout

#### Restore Behaviors
| Mode | Behavior |
|------|----------|
| **Cold Start** (default) | Restore working directories only. User manually starts Claude in each pane. |
| **Warm Start** | Restore working directories AND auto-run `claude` in panes where it was previously active. |

### FR-6: Session Management
| ID | Requirement | Priority |
|----|-------------|----------|
| FR-6.1 | Each terminal shall support standard Claude CLI input/output | Must Have |
| FR-6.2 | Users shall be able to clear terminal scrollback without resetting the session | Should Have |
| FR-6.3 | Application shall detect when Claude process exits and trigger pane reset | Must Have |
| FR-6.4 | Application shall handle Claude session crashes gracefully (reset pane, no app crash) | Must Have |
| FR-6.5 | Users shall be able to kill a hung Claude process via menu/shortcut | Should Have |

### FR-7: Navigation & Focus
| ID | Requirement | Priority |
|----|-------------|----------|
| FR-7.1 | Clicking a pane shall set it as the active input target | Must Have |
| FR-7.2 | Active pane shall have clear visual indicator (border highlight, glow) | Must Have |
| FR-7.3 | Keyboard shortcuts shall allow cycling through panes | Must Have |
| FR-7.4 | Keyboard shortcut shall allow switching layouts | Should Have |
| FR-7.5 | Double-clicking a pane shall toggle it to/from Focus View | Nice to Have |

---

## Non-Functional Requirements

### Performance
| ID | Requirement | Target |
|----|-------------|--------|
| NFR-1 | Application launch time | < 3 seconds |
| NFR-2 | Layout switch latency | < 100ms |
| NFR-3 | Resize animation frame rate | 60fps (16ms frame budget) |
| NFR-4 | Memory usage (4 active sessions) | < 500MB |
| NFR-5 | CPU usage at idle (no active I/O) | < 5% |

### Usability
| ID | Requirement |
|----|-------------|
| NFR-6 | Layout controls shall be discoverable without reading documentation |
| NFR-7 | All primary functions shall be accessible via keyboard |
| NFR-8 | Color scheme shall support both light and dark modes |
| NFR-9 | Font size shall be adjustable (global setting affecting all panes) |

### Reliability
| ID | Requirement |
|----|-------------|
| NFR-10 | Single pane crash shall not affect other panes |
| NFR-11 | Application shall auto-save layout preference |
| NFR-12 | Graceful degradation if Claude CLI is unavailable |

### Compatibility
| ID | Requirement |
|----|-------------|
| NFR-13 | macOS 12+ support (primary target) |
| NFR-14 | Support for Retina/HiDPI displays |
| NFR-15 | Compatible with standard Claude CLI installation |

---

## Success Metrics

| Metric | Target | Measurement Method |
|--------|--------|-------------------|
| **User Adoption** | 500 daily active users within 3 months | Analytics |
| **Session Duration** | Average session > 30 minutes | Analytics |
| **Layout Usage** | >60% of users try multiple layouts | Analytics |
| **Task Completion** | Users can set up 4-pane workspace in < 60 seconds | User testing |
| **Satisfaction** | >4.0/5.0 user satisfaction rating | Survey |
| **Retention** | >40% weekly retention rate | Analytics |

---

## Assumptions & Constraints

### Assumptions
1. Users have Claude CLI already installed and authenticated
2. Users have sufficient system resources to run 4 concurrent Claude sessions
3. Claude CLI supports being run in multiple instances simultaneously
4. Target users are technically proficient (developers, researchers, power users)

### Constraints
1. **Platform Priority**: macOS is the primary target; Windows/Linux are future considerations
2. **Claude Dependency**: Application functionality is dependent on Claude CLI availability and API stability
3. **Terminal Emulation**: Must support standard ANSI escape codes for Claude's formatting
4. **No Session Sync**: Cross-pane features (copy context, share history) are out of scope for v1

### Dependencies
1. Claude CLI installation and authentication
2. Terminal emulation library (e.g., xterm.js for Electron, or native for Swift)
3. System permissions for process spawning

---

## Out of Scope

The following items are explicitly **NOT** included in this PRD:

| Item | Rationale |
|------|-----------|
| More than 4 terminal panes | Maintain simplicity; 4 covers 90% of use cases |
| Built-in Claude authentication | Users handle auth via standard Claude CLI setup |
| Session sharing between panes | Complex feature reserved for future version |
| Custom pane size ratios | Pre-defined layouts reduce complexity |
| Plugin/extension system | Focus on core functionality first |
| Cloud sync of sessions/workspaces | Privacy concerns; local-only for v1 |
| Mobile/tablet support | Desktop-first product |
| General-purpose terminal replacement | Optimized for Claude workflows; basic shell for navigation only |
| Recording/playback of sessions | Feature creep; separate tool territory |
| Windows/Linux support | Future roadmap, not v1 |
| Preserving Claude conversation history across app restarts | Claude CLI manages its own history; app only restores directory state |

---

## Appendix: Layout Mockups

### Grid View (2x2)
```
+-------------------+-------------------+
|                   |                   |
|     Terminal 1    |     Terminal 2    |
|                   |                   |
+-------------------+-------------------+
|                   |                   |
|     Terminal 3    |     Terminal 4    |
|                   |                   |
+-------------------+-------------------+
```

### Focus View (1 + 3)
```
+-----------------------------+---------+
|                             |  Term 2 |
|                             +---------+
|         Terminal 1          |  Term 3 |
|          (Focus)            +---------+
|                             |  Term 4 |
+-----------------------------+---------+
```

### Split View (2 Active)
```
+-------------------+-------------------+
|                   |                   |
|                   |                   |
|     Terminal 1    |     Terminal 2    |
|                   |                   |
|                   |                   |
+-------------------+-------------------+
        [Tab: Term 3] [Tab: Term 4]
```

### Horizontal Stack
```
+-----------+-----------+-----------+-----------+
|           |           |           |           |
|  Term 1   |  Term 2   |  Term 3   |  Term 4   |
|           |           |           |           |
+-----------+-----------+-----------+-----------+
```

### Vertical Stack
```
+---------------------------------------+
|             Terminal 1                |
+---------------------------------------+
|             Terminal 2                |
+---------------------------------------+
|             Terminal 3                |
+---------------------------------------+
|             Terminal 4                |
+---------------------------------------+
```

---

## Appendix: Terminal Lifecycle State Machine

```
                    ┌─────────────────────────────────────────┐
                    │           APP LAUNCH                    │
                    └─────────────────┬───────────────────────┘
                                      │
                    ┌─────────────────▼───────────────────────┐
                    │     Check for saved workspace?          │
                    └─────────────────┬───────────────────────┘
                                      │
              ┌───────────────────────┼───────────────────────┐
              │ No saved state        │ Has saved state       │
              ▼                       ▼                       │
    ┌─────────────────┐    ┌─────────────────────┐           │
    │ Open 4 shells   │    │ Restore directories │           │
    │ in $HOME        │    │ per pane            │           │
    └────────┬────────┘    └──────────┬──────────┘           │
             │                        │                       │
             │              ┌─────────┴─────────┐            │
             │              │ Warm Start pref?  │            │
             │              └─────────┬─────────┘            │
             │                   Yes  │  No                  │
             │              ┌─────────┴─────────┐            │
             │              ▼                   ▼            │
             │    ┌─────────────────┐  ┌─────────────┐       │
             │    │ Auto-run claude │  │ Shell only  │       │
             │    │ where it was    │  │ (user starts│       │
             │    │ previously on   │  │ claude)     │       │
             │    └────────┬────────┘  └──────┬──────┘       │
             │             │                  │              │
             └─────────────┴──────────────────┴──────────────┘
                                      │
                    ┌─────────────────▼───────────────────────┐
                    │         PANE READY (Shell State)        │
                    │  ┌───────────────────────────────────┐  │
                    │  │  $ _                              │  │
                    │  │  User can: cd, ls, claude, etc.   │  │
                    │  └───────────────────────────────────┘  │
                    └─────────────────┬───────────────────────┘
                                      │
                           User types │ `claude`
                                      │
                    ┌─────────────────▼───────────────────────┐
                    │       PANE ACTIVE (Claude State)        │
                    │  ┌───────────────────────────────────┐  │
                    │  │  Claude Code running...           │  │
                    │  │  [highlighted border/indicator]   │  │
                    │  └───────────────────────────────────┘  │
                    └─────────────────┬───────────────────────┘
                                      │
               User exits (/exit) or  │  Claude crashes/Ctrl+C
                                      │
                    ┌─────────────────▼───────────────────────┐
                    │         PANE RESET                      │
                    │  - Stay in same working directory       │
                    │  - Return to shell prompt               │
                    │  - Clear state indicator to "Shell"     │
                    └─────────────────┬───────────────────────┘
                                      │
                                      │ (loops back to Shell State)
                                      ▼
                              [PANE READY]
```

### Key Behaviors

| Event | Result |
|-------|--------|
| App opens (no saved state) | 4 shells in `$HOME` |
| App opens (saved state, Cold Start) | 4 shells in saved directories |
| App opens (saved state, Warm Start) | Shells in saved directories + auto-run `claude` where it was active |
| User types `claude` in shell | Pane transitions to Claude Active state |
| Claude exits normally (`/exit`) | Pane resets to shell in same directory |
| Claude crashes or Ctrl+C | Pane resets to shell in same directory |
| User clicks "Reset Pane" | Pane resets to shell in same directory |
| Saved directory doesn't exist | Fall back to `$HOME` |

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-01-23 | QuadClaude Team | Initial draft |
| 1.1 | 2026-01-23 | QuadClaude Team | Added terminal lifecycle (FR-4), workspace persistence (FR-5), state machine diagram; clarified shell-first behavior |

---

*End of Document*
