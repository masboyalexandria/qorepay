# QorePay — a recurring bill-payment agent with on-chain limits

**Track:** Post-Quantum AI Agents — QoreChain Developer Fest "Build Before Q-Day"
**Network:** QoreChain testnet (`qorechain-diana`, EVM chain ID 9800). Test QOR has no value.
**Licence:** MIT.

QorePay is a "set it and forget it" bill payer for the post-quantum era.
The human owner funds a vault and creates recurring payment plans
(payee, amount, interval, number of payments). An AI agent — the scheduler
— pays each bill when it falls due. The twist: **the agent's limits live
on chain, not in its own code.**

| Rule | Enforced by |
|---|---|
| Max **1 QOR per payment** | `QorePayVault` (chain) |
| Max **3 QOR per day**, per agent | `QorePayVault` (chain) |
| Session **expires after 24 h** | `QorePayVault` (chain) |
| A plan pays **only its fixed payee** (allowlist) | `QorePayVault` (chain) |
| **Instant revocation** by the owner | `QorePayVault` (chain) |
| Treasury exit needs an **ML-DSA-87 signature** from the owner's registered post-quantum key | `pqcVerify` precompile (`0x…0a01`), `pqcKeyStatus` (`0x…0a02`) |

The agent's code contains **no limit check of its own** — it simply tries
to pay, and the chain refuses anything outside the rules. Run
`pnpm agent attack` to watch three attacks get refused live:
a leaked classical key, a stranger paying a plan, and an over-limit payment.

## Architecture

```
owner (human, hybrid secp256k1 + ML-DSA-87)
  │ funds vault, creates plans, revokes sessions
  ▼
QorePayVault (EVM, native QOR) ── plans + sessions + daily caps, all on chain
  │ pay(planId) — only the plan's agent key, only when due, only within caps
  ▼
agent (scheduler, own EVM key) ── reads due plans, submits pay() txs
  │ needs a registered ML-DSA-87 key + a live EVM window to send txs
  ▼
dashboard (http://localhost:3000) ── vault balance, plans, history
```

Three keys, three roles (mirrors the official Workshop 2 bill payer):

| Key | Who holds it | What it can do |
|---|---|---|
| **Owner** | you | Funds the vault, creates plans, revokes the agent. Its ML-DSA-87 key authorises guardian withdrawals. |
| **Agent key** | the scheduler | Pays due plans only — inside the on-chain rules. Holds no money. |
| **Vault** | the contract | Holds the treasury. Money leaves only through a due plan payment, or a guardian withdrawal signed ML-DSA-87. |

## Quick start (testnet)

```sh
pnpm install
cp .env.example .env        # then fill in the owner key (see below)
```

### 1. Keys

```sh
pnpm agent init             # create the agent key (saved in .env, chmod 600)
```

The **owner** is a throwaway testnet account: put its `PRIVATE_KEY` and
`QORE_PQC_RECOVERY_CODE` in `.env` as `OWNER_PRIVATE_KEY` /
`OWNER_PQC_RECOVERY_CODE`. (In this repo's demo setup the owner is the
same throwaway account as the Quantum Pass demo.)

### 2. Faucet (100 QOR / 24 h / account)

Paste the owner `qor1…` address and the agent `qor1…` address into
https://dashboard.qorechain.io/faucet and wait for "Tokens Sent!".

### 3. Register keys + open windows

```sh
pnpm agent setup            # agent: register ML-DSA-87 key + open EVM window
pnpm window register        # owner: same (scaffold helper)
pnpm window open            # owner: open a 600-block, 5-tx window
```

### 4. Deploy + fund the vault

```sh
pnpm agent deploy --fund 10   # deploys QorePayVault, funds it with 10 QOR
```

### 5. Create a recurring plan

```sh
# payee amount-QOR interval-seconds payments
pnpm agent plan 0x8251F4F18524FC92CB60FBd16Be8c8C864f74044 0.8 3600 3
# → 0.8 QOR every hour, 3 times, to that payee (max 1 QOR/payment)
```

Example bills live in [`plans.example.json`](plans.example.json).

### 6. Run the scheduler

```sh
pnpm agent run --once        # pay every plan that is due right now
pnpm agent run --watch 60    # keep watching, check every 60 s
pnpm agent status            # vault, plans, session, history
pnpm dashboard               # status dashboard on http://localhost:3000
```

### 7. Attack simulation

```sh
pnpm agent attack
# [1] leaked classical key → guardian withdrawal with a random ML-DSA-87
#     signature → BLOCKED: BadPqcSignature
# [2] stranger tries to pay a plan → BLOCKED: NotAgent
# [3] legitimate guardian withdrawal, owner signs 0.01 QOR with ML-DSA-87
#     → SIGNED + EXECUTED, hybrid ML-DSA-87: verified
```

### 8. Revoke / cancel (owner)

```sh
pnpm agent revoke <agentAddress>   # kill the session immediately
pnpm agent cancel <planId>         # stop a plan
```

## Tests

```sh
pnpm test:forge     # 21 Foundry tests (vault rules + PQC guardian exit, mocked precompiles)
pnpm test           # 5 Hardhat tests (plans, payments, caps, revoke — simulated network)
pnpm typecheck      # tsc --noEmit
```

The Foundry suite mocks the two PQC precompiles with `vm.etch`
(a signature counts as valid when it equals `keccak256("ok", key, message)`),
exactly the stand-in pattern the official Workshop 2 vault tests use.
The real precompiles run on the testnet — see the attack simulation above.

## Project structure

```
contracts/QorePayVault.sol   the vault: plans, sessions, caps, PQC guardian exit
test/QorePayVault.t.sol      Foundry suite (21 tests, mocked PQC precompiles)
test/QorePayVault.ts         Hardhat suite (5 tests, simulated network)
src/agent.ts                 the scheduler CLI (init/setup/deploy/plan/run/…)
src/qore.ts                  window + PQC-key ceremony helpers
src/dashboard.ts             read-only status dashboard
src/abi.ts                   minimal vault ABI (no build-artifact dependency)
scripts/window.ts            owner window helper (from the official scaffold)
plans.example.json           example bills for the demo
```

## What QorePay adds over the official Workshop 2 bill payer

Workshop 2 pays a fixed list of bills once. QorePay adds the recurring
dimension: **plans** (payee + amount + interval + count) with a next-due
timestamp, a **scheduler** that pays them when due, a **dashboard** with
live status and history, and a **treasury vault** whose non-plan exit is
guarded by ML-DSA-87 — plus an attack simulation that proves the limits
are enforced by the chain, not by the agent's code. The plan/session
design adapts two patterns this team has shipped before: SetPay
(recurring-payment plans, Reactive Network) and AgentPay (capped,
expiring, revocable agent sessions, Aevum) — see
[AI_USAGE.md](AI_USAGE.md) for an honest account of what the AI did
and what the human did.

## Submission status

- [x] Repo public, MIT licence, README, featured image
- [x] Contract + agent + dashboard built and tested locally (26 tests)
- [x] Deployed on QoreChain testnet + end-to-end run verified (see below)
- [ ] Demo video ≤ 3 min (silent)
- [ ] Submit before **2 Dec 2026 23:59 UTC** (3 Dec 07:59 WITA)

## Live testnet record (27 Nov 2026, chain 9800)

- Vault `0x2373754c771b6b7f22e9d60c0c9709ee4ed45352`, deployed + funded 10 QOR, tx `0x538739562cf627cefe182dbe7a2000545289fc7de61faa7499ba57030c540b25`, block 10803279.
- 5 plans created (demo plan 0.8 QOR / 60 s × 3 + the 4 example bills from `plans.example.json`).
- Plan 0 paid 3/3 on schedule by the agent (0.8 QOR each; txs `0x52535c63…`, `0xdf393ab3…`, `0x5e78048b…`) — the recurring loop works; session spent 2.4 QOR of its 3 QOR daily cap.
- Attack simulation, all live: leaked classical key → `BadPqcSignature` (BLOCKED); stranger paying a plan → `NotAgent` (BLOCKED); legitimate ML-DSA-87 guardian withdrawal 0.01 QOR → signed + executed (3×, guardian nonce 0 → 3).
- QoreX link proof (registration): 0.000001 QOR sent from the owner address to itself with memo `bbqd-link:4qDAiET5jqA5`, tx `284FCDED0295F786CAAB55F56FDF4BEEA64B4413BA51282FA27EE9E589CD527A`, code 0, hybrid verified.

## Credits

- QoreChain official examples: Workshop 2 "The bill payer" (`QDayVault`,
  `02-pq-agent`) — patterns studied and re-implemented; no example code
  was copied into this repo.
- Prior work by the same team: [SetPay](https://github.com/masboyalexandria/setpay)
  (recurring payments) and [AgentPay](https://github.com/masboyalexandria/aevum-agentpay)
  (capped agent sessions).
- Built with `@qorechain/sdk` ^0.14.0, Hardhat 3, Foundry, viem.
