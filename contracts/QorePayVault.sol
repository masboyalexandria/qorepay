// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// QoreChain post-quantum precompiles (active on the qorechain-diana testnet).
interface IQorePQC {
    /// ML-DSA-87 (FIPS 204) verification: 2592-byte key, 4627-byte signature.
    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external
        view
        returns (bool valid);

    /// The ML-DSA-87 key an account registered on chain.
    function pqcKeyStatus(address account)
        external
        view
        returns (bool registered, uint8 algorithmId, bytes memory pubkey, bool possessionProven);
}

/// @title QorePayVault
/// @notice A recurring bill-payment vault for a post-quantum AI agent.
///
///         The human owner funds the vault and creates payment plans
///         (payee, amount, interval, number of payments). Each plan is bound
///         to one agent session key. The agent's key can do exactly one
///         thing — call `pay` when a plan falls due — and every limit is
///         checked on chain, on every payment:
///
///           1. a per-payment cap   — no single payment may exceed 1 QOR;
///           2. a daily cap         — no more than 3 QOR per day, per agent;
///           3. an expiry           — the session dies 24 hours after it is
///                                      created, automatically;
///           4. an allowlist        — a plan pays only its fixed payee;
///           5. instant revocation  — the owner kills a session in one tx.
///
///         The agent's code contains NO limit check of its own: it simply
///         tries to pay, and the chain refuses anything outside the rules
///         (see `scripts/attack-sim.ts`: a leaked classical key, an
///         over-limit payment and a payment to a stranger are all refused).
///
///         The treasury itself is guarded post-quantumly: money leaves the
///         vault outside a plan only through `guardianWithdraw`, which
///         requires an ML-DSA-87 signature from the owner's key registered
///         on chain (verified by the `pqcVerify` precompile). A stolen
///         secp256k1 key alone cannot move anything.
///
/// @dev    Single-owner, native-QOR vault. Spending state is updated before
///         any external call (checks-effects-interactions). 1 QOR = 1 ether
///         (18 decimals, standard EVM denomination on QoreChain).
contract QorePayVault {
    IQorePQC internal constant PQC_VERIFY = IQorePQC(0x0000000000000000000000000000000000000a01);
    IQorePQC internal constant PQC_KEYS = IQorePQC(0x0000000000000000000000000000000000000a02);

    /// @notice Hard cap: no single payment may exceed 1 QOR.
    uint256 public constant MAX_PER_PAYMENT = 1 ether;
    /// @notice Hard cap: no agent may spend more than 3 QOR per day.
    uint256 public constant MAX_PER_DAY = 3 ether;
    /// @notice An agent session lives at most 24 hours.
    uint256 public constant LINK_TTL = 24 hours;

    /// @notice One recurring bill-payment plan.
    struct Plan {
        address payee; // fixed recipient (the allowlist: a plan pays nobody else)
        uint256 amount; // QOR (wei) paid per payment
        uint256 interval; // seconds between consecutive payments
        uint256 paymentsLeft; // payments still to be executed
        uint256 nextDue; // timestamp at which the next payment falls due
        address agent; // session key allowed to execute this plan
        bool active;
    }

    /// @notice An agent session key's spending policy and cumulative spend.
    struct Session {
        uint256 perPaymentCap; // max amount allowed for a single payment
        uint256 dailyCap; // max cumulative amount per day
        uint256 spentToday; // amount already paid in the current day window
        uint256 dayStart; // timestamp the current day window started
        uint64 expiresAt; // last timestamp at which the key may pay
        bool active; // false once revoked (or before creation)
    }

    /// @notice The human owner: funds the vault, creates plans, revokes sessions.
    address public immutable owner;

    /// @notice Increases with every guardian withdrawal, so a signature works once.
    uint256 public nonce;

    /// @notice Total number of plans ever created. Plan IDs are sequential from 0.
    uint256 public planCount;

    /// @notice All plans by ID.
    mapping(uint256 => Plan) public plans;

    /// @notice Spending policy per agent session key.
    mapping(address agent => Session) private _sessions;

    event Deposited(address indexed from, uint256 amount);
    event PlanCreated(
        uint256 indexed planId,
        address indexed payee,
        address indexed agent,
        uint256 amount,
        uint256 interval,
        uint256 payments,
        uint64 expiresAt
    );
    event PlanCancelled(uint256 indexed planId);
    event SessionCreated(address indexed agent, uint256 perPaymentCap, uint256 dailyCap, uint64 expiresAt);
    event SessionRevoked(address indexed agent);
    event PaymentExecuted(
        uint256 indexed planId, address indexed agent, address indexed payee, uint256 amount, uint256 paymentsLeft
    );
    event GuardianWithdrawn(address indexed to, uint256 amount, uint256 nonce);

    error NotOwner();
    error NotAgent();
    error ZeroAddress();
    error ZeroAmount();
    error InvalidPlan();
    error PlanNotActive();
    error PaymentNotDue();
    error SessionNotActive();
    error SessionExpired();
    error PerPaymentCapExceeded();
    error DailyCapExceeded();
    error InsufficientVaultBalance();
    error GuardianKeyNotRegistered();
    error GuardianKeyNotProven();
    error BadPqcSignature();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @param owner_ The human owner (guardian). Its registered ML-DSA-87 key
    ///        authorises guardian withdrawals.
    constructor(address owner_) payable {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        if (msg.value > 0) emit Deposited(msg.sender, msg.value);
    }

    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice Deposit native QOR into the vault.
    function deposit() external payable {
        if (msg.value == 0) revert ZeroAmount();
        emit Deposited(msg.sender, msg.value);
    }

    // ------------------------------------------------------------ owner: plans

    /// @notice Create a recurring payment plan and (if it has none) an agent
    ///         session for `agent_` with the standard limits: at most 1 QOR
    ///         per payment, at most 3 QOR per day, expiring 24 hours from now.
    /// @dev    An existing active session is left untouched — creating a plan
    ///         never resets an agent's daily spend or extends its lifetime.
    /// @param payee_ Fixed recipient of every payment (the allowlist).
    /// @param amount_ QOR (wei) paid per payment. Must be > 0 and <= 1 QOR.
    /// @param interval_ Seconds between payments.
    /// @param payments_ Number of payments to execute in total.
    /// @param agent_ The agent session key allowed to execute this plan.
    /// @return planId The ID of the new plan.
    function createPlan(address payee_, uint256 amount_, uint256 interval_, uint256 payments_, address agent_)
        external
        onlyOwner
        returns (uint256 planId)
    {
        if (payee_ == address(0) || agent_ == address(0)) revert ZeroAddress();
        if (amount_ == 0 || amount_ > MAX_PER_PAYMENT) revert InvalidPlan();
        if (interval_ == 0 || payments_ == 0) revert InvalidPlan();

        Session storage session = _sessions[agent_];
        uint64 expiresAt;
        if (!session.active) {
            expiresAt = uint64(block.timestamp + LINK_TTL);
            _sessions[agent_] = Session({
                perPaymentCap: MAX_PER_PAYMENT,
                dailyCap: MAX_PER_DAY,
                spentToday: 0,
                dayStart: block.timestamp,
                expiresAt: expiresAt,
                active: true
            });
            emit SessionCreated(agent_, MAX_PER_PAYMENT, MAX_PER_DAY, expiresAt);
        } else {
            expiresAt = session.expiresAt;
        }

        planId = planCount++;
        plans[planId] = Plan({
            payee: payee_,
            amount: amount_,
            interval: interval_,
            paymentsLeft: payments_,
            nextDue: block.timestamp + interval_,
            agent: agent_,
            active: true
        });

        emit PlanCreated(planId, payee_, agent_, amount_, interval_, payments_, expiresAt);
    }

    /// @notice Cancel one of your active plans. No refund is needed: plans
    ///         draw from the vault's pooled balance, they do not escrow.
    function cancelPlan(uint256 planId_) external onlyOwner {
        Plan storage plan = plans[planId_];
        if (!plan.active) revert PlanNotActive();
        plan.active = false;
        emit PlanCancelled(planId_);
    }

    /// @notice Revoke an agent's session key, effective immediately. Its
    ///         plans stop paying; the recorded spend is kept for auditing.
    function revokeSession(address agent_) external onlyOwner {
        if (!_sessions[agent_].active) revert SessionNotActive();
        _sessions[agent_].active = false;
        emit SessionRevoked(agent_);
    }

    // ------------------------------------------------------------ agent: pay

    /// @notice Execute one due payment of a plan. Callable only by the plan's
    ///         agent session key. Every rule is checked on chain: session
    ///         active, unexpired, plan active and due, amount within the
    ///         per-payment cap, daily cap not exceeded, vault funded.
    /// @dev    The agent's own code performs no limit check — it just tries.
    function pay(uint256 planId_) external {
        Plan storage plan = plans[planId_];
        if (msg.sender != plan.agent) revert NotAgent();
        if (!plan.active || plan.paymentsLeft == 0) revert PlanNotActive();
        if (block.timestamp < plan.nextDue) revert PaymentNotDue();

        Session storage session = _sessions[msg.sender];
        if (!session.active) revert SessionNotActive();
        if (block.timestamp > session.expiresAt) revert SessionExpired();

        uint256 amount = plan.amount;
        if (amount > session.perPaymentCap) revert PerPaymentCapExceeded();

        // Roll the day window forward when a full day has passed.
        if (block.timestamp >= session.dayStart + 1 days) {
            session.spentToday = 0;
            session.dayStart = block.timestamp;
        }
        if (session.spentToday + amount > session.dailyCap) revert DailyCapExceeded();
        if (amount > address(this).balance) revert InsufficientVaultBalance();

        // --- Effects (before any external call) ---------------------------
        session.spentToday += amount;
        plan.paymentsLeft--;
        plan.nextDue = block.timestamp + plan.interval;
        if (plan.paymentsLeft == 0) plan.active = false;

        // --- Interaction ----------------------------------------------------
        (bool ok,) = payable(plan.payee).call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit PaymentExecuted(planId_, msg.sender, plan.payee, amount, plan.paymentsLeft);
    }

    // ------------------------------------------- guardian: PQC-protected exit

    /// @notice The exact bytes the guardian signs for a withdrawal.
    function withdrawalMessage(address to, uint256 amount, uint256 nonce_) public view returns (bytes memory) {
        return abi.encodePacked("QorePayVault:withdraw:v1", block.chainid, address(this), to, amount, nonce_);
    }

    /// @notice Move treasury funds out of the vault without a plan. Only a
    ///         valid ML-DSA-87 signature from the owner's key registered on
    ///         chain authorises it — anyone may submit the transaction
    ///         (a relayer, the agent, the owner), what authorises it is the
    ///         signature, not who sends it. A stolen secp256k1 key alone
    ///         cannot move anything.
    function guardianWithdraw(address payable to, uint256 amount, bytes calldata mldsaSignature) external {
        (bool registered,, bytes memory pubkey, bool proven) = PQC_KEYS.pqcKeyStatus(owner);
        if (!registered || pubkey.length == 0) revert GuardianKeyNotRegistered();
        if (!proven) revert GuardianKeyNotProven();

        uint256 n = nonce;
        if (!PQC_VERIFY.pqcVerify(pubkey, mldsaSignature, withdrawalMessage(to, amount, n))) {
            revert BadPqcSignature();
        }
        if (amount > address(this).balance) revert InsufficientVaultBalance();

        nonce = n + 1;
        emit GuardianWithdrawn(to, amount, n);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ------------------------------------------------------------------ views

    /// @notice The full spending policy and cumulative spend for `agent_`.
    function getSession(address agent_) external view returns (Session memory) {
        return _sessions[agent_];
    }

    /// @notice IDs of plans whose next payment is due at or before now,
    ///         capped at `maxCount_` entries.
    function duePlanIds(uint256 maxCount_) external view returns (uint256[] memory due) {
        uint256 found = 0;
        for (uint256 i = 0; i < planCount && found < maxCount_; i++) {
            Plan storage plan = plans[i];
            if (plan.active && plan.paymentsLeft > 0 && plan.nextDue <= block.timestamp) found++;
        }
        due = new uint256[](found);
        uint256 idx = 0;
        for (uint256 i = 0; i < planCount && idx < found; i++) {
            Plan storage plan = plans[i];
            if (plan.active && plan.paymentsLeft > 0 && plan.nextDue <= block.timestamp) due[idx++] = i;
        }
    }

    /// @notice Number of currently active plans.
    function activePlanCount() external view returns (uint256 count) {
        for (uint256 i = 0; i < planCount; i++) {
            if (plans[i].active) count++;
        }
    }
}
