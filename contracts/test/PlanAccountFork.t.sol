// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PlanAccount} from "../src/PlanAccount.sol";
import {PlanBook} from "../src/PlanBook.sol";

interface VmPlanAccountFork {
    function addr(uint256 privateKey) external returns (address);
    function createSelectFork(string calldata urlOrAlias) external returns (uint256);
    function envOr(string calldata name, string calldata defaultValue) external returns (string memory);
    function prank(address sender) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

interface IERC20Fork {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
}

interface IPancakeQuoterV2Fork {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams calldata params)
        external
        returns (uint256 amountOut, uint160, uint32, uint256);
}

interface IPancakeSmartRouterFork {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @notice Opt-in BSC fork proof against the deployed Pancake V3 contracts and a real bStock.
/// @dev Offline CI returns immediately. Set REDEYE_FORK_RPC to run the real-router path.
contract PlanAccountForkTest {
    VmPlanAccountFork private constant VM = VmPlanAccountFork(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address private constant INTCB = 0xe614E2fc6C787035FF51f452e8E826Bfd32D5283;
    address private constant ROUTER = 0x13f4EA83D0bd40E75C8222255bc855a974568Dd4;
    address private constant QUOTER = 0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997;
    address private constant FUNDED_HOLDER = 0xDA11FAba6da586c4EEE689b3387Af0b0fd00aae2;
    uint24 private constant FEE = 2500;
    uint256 private constant USER_KEY = 0xA11CE;
    uint256 private constant AMOUNT_IN = 2 ether;

    function testForkExecutesTwoDollarRealRouterSwap() external {
        string memory rpc = VM.envOr("REDEYE_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        VM.createSelectFork(rpc);

        address user = VM.addr(USER_KEY);
        PlanBook book = new PlanBook(address(this), address(this));
        PlanAccount account = new PlanAccount(address(book), user);
        bytes32 planHash = keccak256("redeye-plan-account-fork-plan");
        bytes32 eventKey = keccak256("redeye-plan-account-fork-window");
        book.freezePlan(user, eventKey, planHash, "INTC", uint64(block.timestamp + 1 days), 0);

        VM.prank(FUNDED_HOLDER);
        require(IERC20Fork(USDT).transfer(address(account), AMOUNT_IN), "funding failed");

        (uint256 quotedOut,,,) = IPancakeQuoterV2Fork(QUOTER)
            .quoteExactInputSingle(
                IPancakeQuoterV2Fork.QuoteExactInputSingleParams({
                    tokenIn: USDT, tokenOut: INTCB, amountIn: AMOUNT_IN, fee: FEE, sqrtPriceLimitX96: 0
                })
            );
        uint256 minimumOut = (quotedOut * 99 + 99) / 100;
        PlanAccount.Permission memory permission = PlanAccount.Permission({
            planHash: planHash,
            standingRunHash: bytes32(0),
            agent: address(this),
            tokenIn: USDT,
            tokenOut: INTCB,
            maxAmount: AMOUNT_IN,
            router: ROUTER,
            notBefore: uint64(block.timestamp),
            notAfter: uint64(block.timestamp + 1 hours),
            maxPriceDeviationBps: 100
        });
        bytes memory routerData = abi.encodeWithSelector(
            IPancakeSmartRouterFork.exactInputSingle.selector,
            IPancakeSmartRouterFork.ExactInputSingleParams({
                tokenIn: USDT,
                tokenOut: INTCB,
                fee: FEE,
                recipient: user,
                amountIn: AMOUNT_IN,
                amountOutMinimum: minimumOut,
                sqrtPriceLimitX96: 0
            })
        );
        PlanAccount.SwapCall memory swap = PlanAccount.SwapCall({
            planHash: planHash,
            eventKey: eventKey,
            tokenIn: USDT,
            tokenOut: INTCB,
            amountIn: AMOUNT_IN,
            minAmountOut: minimumOut,
            referenceAmountOut: quotedOut,
            value: 0,
            data: routerData
        });
        (uint8 v, bytes32 r, bytes32 s) = VM.sign(USER_KEY, account.permissionDigest(permission));
        account.executeSwap(permission, abi.encodePacked(r, s, v), swap);

        require(IERC20Fork(INTCB).balanceOf(user) >= minimumOut, "owner did not receive bStock");
        require(IERC20Fork(USDT).balanceOf(address(account)) == 0, "input was not fully spent");
        require(account.used(account.permissionHash(permission)), "permission was not consumed");
    }
}
