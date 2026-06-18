#!/usr/bin/env bash
# qcshadow — counterfactual test: would qwen have MATCHED a unit Claude chose to KEEP?
#
# Runs the SAME spec through qwen in an ISOLATED git worktree (checked out to HEAD, so it
# NEVER touches your real working tree or what Claude actually did), runs the ground-truth
# check + the adversarial judge, and appends one record to ~/.quadclaude/eval/shadow.jsonl.
# The dashboard rolls these up to show where Claude is OVER-cautious — keeping work that qwen
# could plausibly have matched. qwen's output is never shipped; this is measurement only.
#
# Usage: qcshadow "<group>" "<spec/prompt>" ["<QC_CHECK command>"]
set -o pipefail
qc="$HOME/.quadclaude"; mkdir -p "$qc/eval"
group="$1"; spec="$2"; check="$3"
if [ -z "$group" ] || [ -z "$spec" ]; then
  echo 'usage: qcshadow "<group>" "<spec>" ["<check>"]' >&2; exit 2
fi
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "qcshadow: not in a git repo (an isolated worktree is required so your real tree is never touched)" >&2; exit 1
fi
root="$(git rev-parse --show-toplevel)"
base="$(mktemp -d)"; wt="$base/wt"
# Isolated worktree at HEAD — qwen attempts the spec from the same pre-work baseline, in
# total isolation. Works even with uncommitted changes in your real tree (they're excluded).
if ! git -C "$root" worktree add --detach -q "$wt" HEAD 2>/dev/null; then
  echo "qcshadow: could not create a worktree (does the repo have at least one commit?)" >&2; rm -rf "$base"; exit 1
fi
printf '\033[2mqcshadow: testing whether qwen could match the KEPT unit "%s" (isolated worktree)…\033[0m\n' "$group"

# Run qwen on the spec inside the worktree. QC_NOLOG keeps it out of real telemetry; we write
# our own shadow line. QC_NO_JUDGE so we run the judge ourselves and capture its verdict.
( cd "$wt" && QC_NOLOG=1 QC_NO_JUDGE=1 QC_TASK="shadow" QC_CHECK="$check" qcdelegate "$spec" ) >/dev/null 2>&1
qwen_exit=$?

# Objective ground truth: run the same check in the worktree, if one was given.
chk_exit=""
if [ -n "$check" ]; then ( cd "$wt" && sh -c "$check" ) >/dev/null 2>&1; chk_exit=$?; fi

# Subjective quality: adversarial judge on qwen's diff vs the spec (SHIP / CAUTION / REVIEW).
verdict="$( cd "$wt" && qceval judge "$spec" 2>/dev/null | grep -oE 'verdict: [A-Z]+' | awk '{print $2}' | head -1 )"
[ -z "$verdict" ] && verdict="unknown"

# couldMatch: prefer the objective check; else fall back to the judge.
could="inconclusive"
if [ -n "$check" ]; then
  [ "$chk_exit" = "0" ] && could="yes" || could="no"
elif [ "$verdict" = "SHIP" ]; then could="likely"
elif [ "$verdict" = "REVIEW" ] || [ "$verdict" = "REJECT" ]; then could="no"
fi

# Coarse task class from the changed files + the group label (mirrors qceval's classifier).
f="$( cd "$wt" && git diff --name-only 2>/dev/null | tr 'A-Z' 'a-z' )"
g="$( printf %s "$group" | tr 'A-Z' 'a-z' )"
class="logic"
case "$f $g" in
  *test*|*spec.*|*/test/*)              class="test" ;;
  *.json*|*.yaml*|*.yml*|*\ data*|*schema*|*fixture*) class="data" ;;
  *.md*|*\ doc*|*readme*)               class="docs" ;;
  *.css*|*.scss*|*.tsx*|*.jsx*|*ui*|*component*|*design*|*brand*|*layout*) class="ui" ;;
  *.config*|*\ config*|*setup*|*scaffold*) class="config" ;;
esac

jesc(){ printf %s "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n\r\t' '   '; }
chk_json="null"; [ -n "$check" ] && chk_json="{\"command\":\"$(jesc "$check")\",\"exit\":${chk_exit:-null}}"
printf '{"ts":"%s","type":"shadow","group":"%s","project":"%s","taskClass":"%s","qwenExit":%s,"check":%s,"judgeVerdict":"%s","couldMatch":"%s"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(jesc "$group")" "$(jesc "$root")" "$class" "${qwen_exit:-1}" "$chk_json" "$verdict" "$could" >> "$qc/eval/shadow.jsonl"

case "$could" in
  yes)    msg="✅ qwen MATCHED — passed the same check you kept this for" ;;
  likely) msg="🟡 qwen likely matched — adversarial judge said SHIP (no objective check)" ;;
  no)     msg="❌ qwen fell short — KEEP was justified" ;;
  *)      msg="• inconclusive — qwen ran but no objective check to compare" ;;
esac
printf '\033[2mqcshadow [%s]: %s · judge %s\033[0m\n' "$class" "$msg" "$verdict"

git -C "$root" worktree remove --force "$wt" >/dev/null 2>&1
rm -rf "$base"
