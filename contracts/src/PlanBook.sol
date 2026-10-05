// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract PlanBook {
    error NotOwner();
    error NotAgent();
    error ZeroAddress();
    error ZeroHash();
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
    event DecisionRecorded(uint256 indexed planId, bytes32 decisionHash, uint64 at);
    event FillRecorded(uint256 indexed planId, bytes32 txHash, uint8 step);
    event VerdictRecorded(uint256 indexed planId, uint8 outcome, bytes32 verdictHash);
    event PlanCancelled(uint256 indexed planId, uint64 at);
    event AgentChanged(address indexed previousAgent, address indexed newAgent);

    struct Plan {
        address owner;
        bytes32 eventKey;
        bytes32 planHash;
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

    function freezePlan(
        address planOwner,
        bytes32 eventKey,
        bytes32 planHash,
        string calldata ticker,
        uint64 releaseTs,
        uint256 jobId
    ) external onlyAgent returns (uint256 planId) {
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
            ticker: ticker,
            releaseTs: releaseTs,
            jobId: jobId,
            decisionRecorded: false,
            verdictRecorded: false,
            cancelled: false
        });
        planForOwnerAndEvent[uniqueKey] = planId;
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

    function _plan(uint256 planId) internal view returns (Plan storage plan) {
        plan = plans[planId];
        if (plan.owner == address(0)) revert PlanMissing();
    }
}
