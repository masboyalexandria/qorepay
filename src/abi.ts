/**
 * Minimal human-readable ABI for QorePayVault (kept in code so the agent
 * does not depend on Hardhat build artifacts at runtime).
 * Parsed with viem's parseAbi — writeContract/readContract need the parsed
 * form, not raw strings.
 */
import { parseAbi } from "viem";

export const QORE_PAY_VAULT_ABI = parseAbi([
  "constructor(address owner_) payable",
  "function owner() view returns (address)",
  "function nonce() view returns (uint256)",
  "function planCount() view returns (uint256)",
  "function MAX_PER_PAYMENT() view returns (uint256)",
  "function MAX_PER_DAY() view returns (uint256)",
  "function LINK_TTL() view returns (uint256)",
  "function deposit() payable",
  "function createPlan(address payee_, uint256 amount_, uint256 interval_, uint256 payments_, address agent_) returns (uint256 planId)",
  "function cancelPlan(uint256 planId_)",
  "function revokeSession(address agent_)",
  "function pay(uint256 planId_)",
  "function guardianWithdraw(address to, uint256 amount, bytes mldsaSignature)",
  "function withdrawalMessage(address to, uint256 amount, uint256 nonce_) view returns (bytes)",
  "function plans(uint256) view returns (address payee, uint256 amount, uint256 interval, uint256 paymentsLeft, uint256 nextDue, address agent, bool active)",
  "function getSession(address agent_) view returns (uint256 perPaymentCap, uint256 dailyCap, uint256 spentToday, uint256 dayStart, uint64 expiresAt, bool active)",
  "function duePlanIds(uint256 maxCount_) view returns (uint256[] due)",
  "function activePlanCount() view returns (uint256)",
  "event Deposited(address indexed from, uint256 amount)",
  "event PlanCreated(uint256 indexed planId, address indexed payee, address indexed agent, uint256 amount, uint256 interval, uint256 payments, uint64 expiresAt)",
  "event PlanCancelled(uint256 indexed planId)",
  "event SessionCreated(address indexed agent, uint256 perPaymentCap, uint256 dailyCap, uint64 expiresAt)",
  "event SessionRevoked(address indexed agent)",
  "event PaymentExecuted(uint256 indexed planId, address indexed agent, address indexed payee, uint256 amount, uint256 paymentsLeft)",
  "event GuardianWithdrawn(address indexed to, uint256 amount, uint256 nonce)",
  "error NotOwner()",
  "error NotAgent()",
  "error ZeroAddress()",
  "error ZeroAmount()",
  "error InvalidPlan()",
  "error PlanNotActive()",
  "error PaymentNotDue()",
  "error SessionNotActive()",
  "error SessionExpired()",
  "error PerPaymentCapExceeded()",
  "error DailyCapExceeded()",
  "error InsufficientVaultBalance()",
  "error GuardianKeyNotRegistered()",
  "error GuardianKeyNotProven()",
  "error BadPqcSignature()",
  "error TransferFailed()",
]);
