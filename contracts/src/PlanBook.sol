// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Public record of plans and their proof hashes. It holds no funds.
/// @dev The historical field name `releaseTs` is the lock boundary for every
///      window. A plan cannot be frozen at or after that lock time.
contract PlanBook {
    error NotOwner();
    error NotAgent();
    error ZeroAddress();
    error ZeroHash();
    error ZeroStandingRunHash();
    error EmptyTicker();
    error ReleaseAlreadyStarted();
    error DuplicatePlan();
    error PlanMissing();
    error PlanAlreadyCancelled();
    error DecisionAlreadyRecorded();
    error DecisionRequired();
    error VerdictAlreadyRecorded();
    error InvalidOutcome();
    error FillAfterVerdict();
    error CancelAfterRelease();

    event PlanFrozen(
        uint256 indexed planId,
        address indexed owner,
        bytes32 indexed eventKey,
        bytes32 planHash,
        string ticker,
        uint64 releaseTs,
        uint256 jobId
    );
    event StandingPlanFrozen(uint256 indexed planId, bytes32 indexed standingRunHash);
    event DecisionRecorded(uint256 indexed planId, bytes32 decisionHash, uint64 at);
    event FillRecorded(uint256 indexed planId, bytes32 txHash, uint8 step);
    event VerdictRecorded(uint256 indexed planId, uint8 outcome, bytes32 verdictHash);
    event PlanCancelled(uint256 indexed planId, uint64 at);
    event AgentChanged(address indexed previousAgent, address indexed newAgent);

    struct Plan {
        address owner;
        bytes32 eventKey;
        bytes32 planHash;
        bytes32 standingRunHash;
        string ticker;
        uint64 releaseTs;
        uint256 jobId;
        bool decisionRecorded;
        bool verdictRecorded;
        bool cancelled;
    }

    address public immutable owner;
    address public agent;
    uint256 public nextPlanId = 1;

    uint256 private keptCount;
    uint256 private refusedCount;
    uint256 private brokenCount;
    uint256 private cancelledCount;
    uint256 private openCount;

    mapping(uint256 => Plan) private plans;
    mapping(bytes32 => uint256) private planForOwnerAndEvent;
    mapping(bytes32 => bool) private frozenPlanHashForOwner;
    mapping(bytes32 => uint256) private planIdForHash;

    constructor(address initialOwner, address initialAgent) {
        if (initialOwner == address(0) || initialAgent == address(0)) revert ZeroAddress();
        owner = initialOwner;
        agent = initialAgent;
    }

    modifier onlyOwner() {
        _onlyOwner();
        _;
    }

    modifier onlyAgent() {
        _onlyAgent();
        _;
    }

    function _onlyOwner() internal view {
        if (msg.sender != owner) revert NotOwner();
    }

    function _onlyAgent() internal view {
        if (msg.sender != agent) revert NotAgent();
    }

    function setAgent(address newAgent) external onlyOwner {
        if (newAgent == address(0)) revert ZeroAddress();
        emit AgentChanged(agent, newAgent);
        agent = newAgent;
    }

    /// @notice Publishes a plan before its lock boundary.
    /// @param releaseTs The UTC lock time; the legacy ABI name is retained for compatibility.
    function freezePlan(
        address planOwner,
        bytes32 eventKey,
        bytes32 planHash,
        string calldata ticker,
        uint64 releaseTs,
        uint256 jobId
    ) external onlyAgent returns (uint256 planId) {
        return _freezePlan(planOwner, eventKey, planHash, bytes32(0), ticker, releaseTs, jobId);
    }

    /// @notice Publishes one copy of a standing plan before its window lock boundary.
    /// @dev The signed run fingerprint is carried by PlanAccount; each copy still
    ///      has its own plan hash and event key in this public record.
    function freezeStandingPlan(
        address planOwner,
        bytes32 eventKey,
        bytes32 planHash,
        bytes32 standingRunHash,
        string calldata ticker,
        uint64 releaseTs,
        uint256 jobId
    ) external onlyAgent returns (uint256 planId) {
        if (standingRunHash == bytes32(0)) revert ZeroStandingRunHash();
        planId = _freezePlan(planOwner, eventKey, planHash, standingRunHash, ticker, releaseTs, jobId);
        emit StandingPlanFrozen(planId, standingRunHash);
    }

    function _freezePlan(
        address planOwner,
        bytes32 eventKey,
        bytes32 planHash,
        bytes32 standingRunHash,
        string calldata ticker,
        uint64 releaseTs,
        uint256 jobId
    ) internal returns (uint256 planId) {
        if (planOwner == address(0)) revert ZeroAddress();
        if (eventKey == bytes32(0) || planHash == bytes32(0)) revert ZeroHash();
        if (bytes(ticker).length == 0) revert EmptyTicker();
        if (block.timestamp >= releaseTs) revert ReleaseAlreadyStarted();

        bytes32 uniqueKey = keccak256(abi.encodePacked(planOwner, eventKey));
        if (planForOwnerAndEvent[uniqueKey] != 0) revert DuplicatePlan();

        planId = nextPlanId++;
        plans[planId] = Plan({
            owner: planOwner,
            eventKey: eventKey,
            planHash: planHash,
            standingRunHash: standingRunHash,
            ticker: ticker,
            releaseTs: releaseTs,
            jobId: jobId,
            decisionRecorded: false,
            verdictRecorded: false,
            cancelled: false
        });
        planForOwnerAndEvent[uniqueKey] = planId;
        bytes32 hashKey = keccak256(abi.encode(planOwner, planHash));
        frozenPlanHashForOwner[hashKey] = true;
        planIdForHash[hashKey] = planId;
        openCount++;
        emit PlanFrozen(planId, planOwner, eventKey, planHash, ticker, releaseTs, jobId);
    }

    function recordDecision(uint256 planId, bytes32 decisionHash) external onlyAgent {
        Plan storage plan = _plan(planId);
        if (plan.cancelled || plan.verdictRecorded) revert FillAfterVerdict();
        if (plan.decisionRecorded) revert DecisionAlreadyRecorded();
        plan.decisionRecorded = true;
        emit DecisionRecorded(planId, decisionHash, uint64(block.timestamp));
    }

    function recordFill(uint256 planId, bytes32 txHash, uint8 step) external onlyAgent {
        Plan storage plan = _plan(planId);
        if (plan.cancelled || plan.verdictRecorded) revert FillAfterVerdict();
        if (!plan.decisionRecorded) revert DecisionRequired();
        if (txHash == bytes32(0)) revert ZeroHash();
        emit FillRecorded(planId, txHash, step);
    }

    function recordVerdict(uint256 planId, uint8 outcome, bytes32 verdictHash) external onlyAgent {
        Plan storage plan = _plan(planId);
        if (plan.cancelled || plan.verdictRecorded) revert VerdictAlreadyRecorded();
        if (outcome < 1 || outcome > 3) revert InvalidOutcome();
        if (verdictHash == bytes32(0)) revert ZeroHash();
        if (outcome != 2 && !plan.decisionRecorded) revert DecisionRequired();

        plan.verdictRecorded = true;
        openCount--;
        if (outcome == 1) keptCount++;
        if (outcome == 2) refusedCount++;
        if (outcome == 3) brokenCount++;
        emit VerdictRecorded(planId, outcome, verdictHash);
    }

    function cancelPlan(uint256 planId) external onlyAgent {
        Plan storage plan = _plan(planId);
        if (plan.cancelled || plan.verdictRecorded) revert VerdictAlreadyRecorded();
        if (block.timestamp >= plan.releaseTs) revert CancelAfterRelease();
        plan.cancelled = true;
        openCount--;
        cancelledCount++;
        emit PlanCancelled(planId, uint64(block.timestamp));
    }

    function counts()
        external
        view
        returns (uint256 kept, uint256 refused, uint256 broken, uint256 cancelled, uint256 open)
    {
        return (keptCount, refusedCount, brokenCount, cancelledCount, openCount);
    }

    function getPlan(uint256 planId) external view returns (Plan memory) {
        return _plan(planId);
    }

    function planIdFor(address planOwner, bytes32 eventKey) external view returns (uint256) {
        return planForOwnerAndEvent[keccak256(abi.encodePacked(planOwner, eventKey))];
    }

    function isPlanHashFrozen(address planOwner, bytes32 planHash) external view returns (bool) {
        return frozenPlanHashForOwner[keccak256(abi.encode(planOwner, planHash))];
    }

    function isPlanHashActive(address planOwner, bytes32 planHash) external view returns (bool) {
        bytes32 hashKey = keccak256(abi.encode(planOwner, planHash));
        if (!frozenPlanHashForOwner[hashKey]) return false;
        uint256 planId = planIdForHash[hashKey];
        Plan storage plan = plans[planId];
        return !plan.cancelled && !plan.verdictRecorded;
    }

    function isStandingPlanForRunAndEvent(
        address planOwner,
        bytes32 standingRunHash,
        bytes32 planHash,
        bytes32 eventKey
    ) external view returns (bool) {
        if (standingRunHash == bytes32(0) || planHash == bytes32(0) || eventKey == bytes32(0)) {
            return false;
        }
        bytes32 hashKey = keccak256(abi.encode(planOwner, planHash));
        uint256 planId = planIdForHash[hashKey];
        if (planId == 0) return false;
        Plan storage plan = plans[planId];
        return
            plan.standingRunHash == standingRunHash &&
            plan.eventKey == eventKey &&
            !plan.cancelled &&
            !plan.verdictRecorded;
    }

    function _plan(uint256 planId) internal view returns (Plan storage plan) {
        plan = plans[planId];
        if (plan.owner == address(0)) revert PlanMissing();
    }
}
