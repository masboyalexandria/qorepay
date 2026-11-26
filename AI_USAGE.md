# AI Usage — QorePay

Honest account of how AI was used to build this project, for the
"Best AI-Native" award and for the judges. Nothing here is hidden:
if a human had written any part by hand, it would say so.

## What the AI did (Muse, an AI coding agent)

- **Design:** proposed the QorePay concept (recurring bill payments with
  on-chain limits) from the official track examples ("bill payer",
  "DCA agent") and the team's prior SetPay / AgentPay work; designed
  `QorePayVault` (plans + agent sessions + daily caps + ML-DSA-87
  guardian exit) and the three-key architecture.
- **Smart contract:** wrote `contracts/QorePayVault.sol` from scratch
  (the PQC precompile interface and the guardian-withdrawal pattern
  follow the official Workshop 2 `QDayVault`, which was studied, not
  copied — no example file was copied into this repo).
- **Tests:** wrote all 21 Foundry tests and all 5 Hardhat tests,
  including the mocked-precompile technique for local testing.
- **Agent + dashboard:** wrote `src/agent.ts` (scheduler CLI),
  `src/qore.ts` (window / PQC-key ceremony), `src/dashboard.ts`
  (status page), and the attack simulation.
- **Docs:** wrote this README, the test plan, and the demo script.
- **Verification:** ran every test suite locally until green
  (26 passing), ran the typechecker, and checked the live testnet
  endpoints (balances, RPC health) before deploying.

## What the human did (Mas Boy Alexandria, solo)

- **Chose the track and the concept:** Post-Quantum AI Agents, and the
  "recurring bill payer" idea over the alternatives (plain DCA agent,
  treasury assistant).
- **Set the requirements:** the limits (1 QOR/payment, 3 QOR/day,
  24 h sessions), the allowlist, the ML-DSA-87 treasury guard, the
  attack simulation, and the rule that limits must be enforced by the
  chain, not by the agent's code.
- **Directed the build:** picked the stack, approved the plan/session
  design, and decided what to cut when the schedule got tight.
- **Owns the accounts and the keys:** the GitHub account, the X
  account, the testnet accounts, and the faucet claims are his; the
  agent only ever held throwaway testnet keys.
- **Reviewed and will test:** he reviews the repo and the demo, runs
  the demo himself, records the demo video, and submits the project.
  The final submission text is written by him.

## What the AI did NOT do

- It did not create the human's accounts, touch his private keys or
  seed phrases, spend real money, or submit anything to the fest
  (submission is a separate, human step).
- It did not fabricate test results: every test count in the README
  is the output of a real local run (see the repo's test files), and
  every on-chain address / transaction hash in the submission is a
  real testnet value, verified against the explorer.
- It did not copy code from the official examples: the vault, the
  agent and the dashboard are original implementations informed by
  reading the official docs and examples (credited in the README).
