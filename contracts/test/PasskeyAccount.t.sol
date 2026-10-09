// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PasskeyAccountFactory} from "../src/PasskeyAccountFactory.sol";
import {PasskeyOwner} from "../src/PasskeyOwner.sol";
import {PlanAccount} from "../src/PlanAccount.sol";
import {PlanBook} from "../src/PlanBook.sol";

interface VmPasskeyAccount {
    function etch(address target, bytes calldata code) external;
    function prank(address sender) external;
}

contract AcceptP256 {
    fallback() external {
        assembly {
            mstore(0, 1)
            return(0, 32)
        }
    }
}

contract PasskeyToken {
    mapping(address => mapping(address => uint256)) public allowance;

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
}

contract PasskeyRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    address public recipient;

    function exactInputSingle(ExactInputSingleParams calldata params) external returns (uint256) {
        recipient = params.recipient;
        return params.amountOutMinimum;
    }
}

contract PasskeyAccountTest {
    VmPasskeyAccount private constant VM = VmPasskeyAccount(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;

    function _assert(bool condition, string memory message) private pure {
        require(condition, message);
    }

    function _assertion(PasskeyOwner owner, bytes32 digest, bytes1 flags) private view returns (bytes memory) {
        string memory challenge = owner.challengeForDigest(digest);
        string memory client = string.concat(
            "{\"type\":\"webauthn.get\",\"challenge\":\"", challenge, "\",\"origin\":\"https://theredeyed-agent.site\"}"
        );
        bytes memory authData = new bytes(37);
        authData[32] = flags;
        return abi.encode(bytes32(uint256(1)), bytes32(uint256(2)), 23, 1, authData, client);
    }

    function testFactoryPredictsAndCreatesPasskeyAccount() external {
        PlanBook book = new PlanBook(address(this), address(0xA11CE));
        PasskeyAccountFactory factory = new PasskeyAccountFactory(address(book));
        bytes32 credential = keccak256("telegram-user-credential");
        bytes32 qx = bytes32(uint256(11));
        bytes32 qy = bytes32(uint256(12));
        (address predictedAccount, address predictedOwner) = factory.predictAccount(credential, qx, qy);
        (address account, address owner) = factory.createAccount(credential, qx, qy);

        _assert(account == predictedAccount, "account prediction mismatch");
        _assert(owner == predictedOwner, "owner prediction mismatch");
        _assert(PlanAccount(account).accountAddress() == account, "account does not own funds");
        _assert(PlanAccount(account).accountOwner() == owner, "passkey signer not configured");
        _assert(PasskeyOwner(owner).publicKeyX() == qx, "wrong public key x");
        _assert(PasskeyOwner(owner).publicKeyY() == qy, "wrong public key y");
    }

    function testWebAuthnRequiresChallengePresenceAndUserVerification() external {
        AcceptP256 verifier = new AcceptP256();
        VM.etch(address(0x100), address(verifier).code);
        PasskeyOwner owner = new PasskeyOwner(bytes32(uint256(11)), bytes32(uint256(12)));
        bytes32 digest = keccak256("bounded permission");

        bytes memory valid = _assertion(owner, digest, 0x05);
        _assert(owner.isValidSignature(digest, valid) == ERC1271_MAGIC, "valid assertion refused");
        _assert(
            owner.isValidSignature(keccak256("another permission"), valid) != ERC1271_MAGIC,
            "assertion replayed for another digest"
        );
        bytes memory noBiometric = _assertion(owner, digest, 0x01);
        _assert(
            owner.isValidSignature(digest, noBiometric) != ERC1271_MAGIC, "assertion without user verification accepted"
        );
    }

    function testWebAuthnOwnerExecutesBoundedPlanFromAccountAddress() external {
        AcceptP256 verifier = new AcceptP256();
        VM.etch(address(0x100), address(verifier).code);
        address agent = address(0xA11CE);
        PlanBook book = new PlanBook(address(this), agent);
        PasskeyOwner owner = new PasskeyOwner(bytes32(uint256(11)), bytes32(uint256(12)));
        PlanAccount account = new PlanAccount(address(book), address(owner));
        PasskeyToken token = new PasskeyToken();
        PasskeyRouter router = new PasskeyRouter();
        bytes32 planHash = keccak256("passkey plan");
        bytes32 eventKey = keccak256("INTC:weekend:2026-10-09");
        VM.prank(agent);
        book.freezePlan(address(account), eventKey, planHash, "INTC", uint64(block.timestamp + 1 days), 1);
        PlanAccount.Permission memory permission = PlanAccount.Permission({
            planHash: planHash,
            standingRunHash: bytes32(0),
            agent: agent,
            tokenIn: address(token),
            tokenOut: address(0xBEEF),
            maxAmount: 2 ether,
            router: address(router),
            notBefore: uint64(block.timestamp),
            notAfter: uint64(block.timestamp + 1 hours),
            maxPriceDeviationBps: 100
        });
        bytes memory data = abi.encodeWithSelector(
            router.exactInputSingle.selector,
            PasskeyRouter.ExactInputSingleParams({
                tokenIn: address(token),
                tokenOut: address(0xBEEF),
                fee: 2500,
                recipient: address(account),
                amountIn: 2 ether,
                amountOutMinimum: 99,
                sqrtPriceLimitX96: 0
            })
        );
        PlanAccount.SwapCall memory swap = PlanAccount.SwapCall({
            planHash: planHash,
            eventKey: eventKey,
            tokenIn: address(token),
            tokenOut: address(0xBEEF),
            amountIn: 2 ether,
            minAmountOut: 99,
            referenceAmountOut: 100,
            value: 0,
            data: data
        });
        bytes memory assertion = _assertion(owner, account.permissionDigest(permission), 0x05);

        VM.prank(agent);
        account.executeSwap(permission, assertion, swap);
        _assert(router.recipient() == address(account), "output did not return to account");
        _assert(account.used(account.permissionHash(permission)), "permission not consumed");
    }
}
