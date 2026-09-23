# Bellum

A cross-paradigm arena for Risk-style world conquest. LLM agents, hand-written
algorithmic agents, and neuroevolved agents play the same game under the same
protocol, on one ladder, and a human can drop into a single session from a phone.

Nothing like this exists. Risk is absent from OpenSpiel and from the Tabletop
Games framework; the strongest published Risk agent (arXiv:2009.06355) had to
benchmark against a closed-source commercial game because there was no open
engine to use; and there is no NEAT-on-Risk work anywhere. The pieces below are
borrowed from the best of what does exist, but the arena is new.

## What is here

```text
packages/core     rules engine, protocol, observation, match drivers   (no deps)
packages/agents   random, heuristic, and the NEAT / LLM / human seats
packages/arena    TrueSkill ladder, tournament runner, replay capture, CLI
viewer/           the live arena page - bundles the engine to 24 KB for the browser
```

```bash
npm install
npm test            # 7 tests, ~2s
npm run arena 200   # run a 200-game ladder across all three paradigms
npm run preview     # build viewer/arena.html - plays live matches in a browser
```

## The one design decision everything rests on

**A bot's turn is a pure in-process function `(observation) -> action`.**
Subprocess pipes, HTTP, and LLM calls are adapters over that, never the base case.

Every existing Risk bot framework gets this backwards. The SYNCS Bot Battle
engine — the best of them, and the source of this project's action vocabulary —
speaks to bots only over FIFO pipes, so a neuroevolution run pays a process spawn
per genome per game. Warlight's engine has the same shape.

Inverting it gives **two clocks over one rule set**:

| | driver | agents | throughput |
|---|---|---|---|
| batch | `runMatchSync` | must be synchronous | 113 six-player games/sec, single core |
| live | `runMatch` | may return Promises | one move per LLM round-trip |

`Agent.act` returns `Move | Promise<Move>`. That union is the whole trick: the
batch runner never touches the microtask queue, and no agent knows which clock it
is on. `Agent.synchronous` lets the tournament pick the fast path automatically.

The engine itself is a **generator** — it yields a `Query` and is resumed with a
`Move` — so there is exactly one implementation of the rules for both clocks, and
later for the browser.

## What was borrowed, and from where

| Source | Taken |
|---|---|
| [SYNCS Bot Battle engine](https://github.com/syncs-usyd/risk-game-engine) | The 8-query action vocabulary and per-player state censoring. Bots written for it port over easily. |
| [RiskArena](https://github.com/radkoff/RiskArena) | Headless "war games" batch mode. Its precomputed odds tables are derived here instead, so they stay correct if combat is ever varied. |
| [Warlight AI Challenge](https://github.com/theaigames/warlight2-engine) / [conquest-engine-gui](https://github.com/kefik/conquest-engine-gui) | Tournament automation shape; replay logs; treating the human as just another bot command. |
| Lux Delux bot community | The heuristic strategy: value continents by bonus-per-border, stage troops in one place, always take one territory a turn for the card. |
| [arXiv:2009.06355](https://arxiv.org/abs/2009.06355) (GCN + TD-lambda) | The observation is map-shaped, not phase-shaped: per-territory features over a static adjacency matrix, ready to feed a graph convolution. |
| TrueSkill | Ratings, because Elo cannot express a six-way free-for-all or "this agent has only played three games". |

## Status

Working: full standard rules (claim, reinforce, escalating card sets, dice
combat, conquest, elimination with hand transfer and forced redemption,
connectivity-checked fortify), seeded reproducibility, fog of war, replay
records, illegal-move detection, TrueSkill ladder, random + heuristic agents, and
the NEAT / LLM / human adapters.

Also working: the live arena page. The engine has no runtime dependencies, so
it bundles to 24 KB and runs in the browser - the page plays real matches rather
than replaying a recording, and turbo mode spends a per-frame time budget on the
engine and paints whatever state it lands on.

Not yet built: an actual NEAT implementation (only the `Policy` contract), a
provider binding for `LlmAgent` (only the `Completion` contract), and the human
seat wired to the board.

### Two things the first run already surfaced

1. **The ladder currently rewards survival over winning.** In the smoke
   tournament an untrained random-weight network topped the table with an 11.7%
   win rate, because a passive bot holds a decent average rank in games that hit
   the turn cap. Ranking-based TrueSkill is right for a ladder, but "champion"
   probably wants wins weighted more heavily, or the turn cap treated as a draw
   for everyone rather than a placing. Decide before the numbers mean anything.

2. **Random play stalemates; competent play does not.** 10 of 60 random
   two-player games reached a conquest even at 1500 plies, against 58 of 60 for
   heuristic games at 400. Fitness for early NEAT generations therefore cannot be
   win-rate — it has to be shaped (territories held, income, survival time) or
   the entire first population scores identically zero.

## Next

- NEAT over the `Policy` contract, with shaped fitness and the heuristic as the
  fixed opponent.
- A provider binding for `LlmAgent`, and a repair-rate column on the ladder.
- Match server plus PWA. `affordances()` in `packages/agents/src/human.ts`
  already enumerates everything a touch UI needs to render a turn, so the client
  ships no rules of its own.
- Typed diplomacy channel — offers and truces every paradigm can emit, not just
  chat text for the LLMs. Nobody has done this, and retrofitting it is brutal.

A note on the name: Bellum, not Risk. Hasbro owns that one, which is why
everything in this space is called Domination, Conquest, Lux, or Warzone.

## Deploying

`npm run build:web` emits `dist/index.html` — one self-contained file, ~51 KB,
engine inlined, nothing fetched at runtime. There is no backend and no asset
directory, so hosting it is a single S3 sync.

Infrastructure is the static-only subset of
[spa-on-aws](https://github.com/mbroadfo/spa-on-aws): S3 + CloudFront + ACM,
with Cloudflare DNS managed inside Terraform (unproxied — double-proxying
breaks ACM validation). `lambda.tf`, `api_gateway.tf` and the `archive`
provider are omitted.

### One-time setup

```powershell
# Admin credentials are used once, here, and nowhere else afterwards.
$env:AWS_PROFILE = "admin"
./scripts/bootstrap.ps1 `
  -App riskarena `
  -Domain riskarena.xaminisalamini.com `
  -GithubRepo mbroadfo/bellum `
  -Branch master `
  -CfZoneId <zone id> `
  -CfToken (Get-Clipboard)
```

This creates the Terraform state bucket, the GitHub OIDC provider, the scoped
`riskarena-terraform` and `riskarena-ci` roles, and the GitHub Variables. No AWS
keys are ever stored in GitHub.

Then push. `devops-infra.yml` applies the stack on changes under `terraform/`
and writes `S3_BUCKET` and `CLOUDFRONT_DIST_ID` back as GitHub Variables;
`devops-frontend.yml` type-checks, tests, builds, syncs and invalidates on
changes under `packages/` or `viewer/`.

**Watch the branch.** The OIDC trust policy is scoped to one branch, and
bootstrap defaults to `main` while this repo is on `master`. Pass
`-Branch master`, or rename the branch first — a mismatch fails at role
assumption with an opaque error.

### Local plan

```bash
cp terraform/terraform.tfvars.example terraform/terraform.tfvars   # then edit
export TF_VAR_cloudflare_api_token=...        # never put the token in the file
terraform -chdir=terraform init
terraform -chdir=terraform plan
```

`*.tfvars` is gitignored; `*.tfvars.example` is not.

### Upstream divergence worth reporting

`spa-on-aws`'s `outputs.tf` wraps the Lambda outputs in `try()` and the README
says the file needs no edits when you delete `api_gateway.tf` and `lambda.tf`.
That is not true: `try()` catches evaluation errors, but a reference to a
resource that was never declared fails at `terraform validate`. Those two
outputs are deleted here, and the matching lines are removed from
`devops-infra.yml`.

### Why not just share the Claude artifact

The artifact is the review surface, not the release. It lives on a
`claude.ai/code/artifact/<uuid>` URL that cannot be pointed at a custom domain —
a CNAME would need claude.ai to serve and certify your hostname — and a public
site should not depend on a personal account's sharing settings.
