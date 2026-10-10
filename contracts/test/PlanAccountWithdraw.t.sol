// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PasskeyOwner} from "../src/PasskeyOwner.sol";
import {PlanAccount} from "../src/PlanAccount.sol";
import {PlanBook} from "../src/PlanBook.sol";

interface VmWithdraw {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function etch(address target, bytes calldata code) external;
    function deal(address who, uint256 amount) external;
    function warp(uint256 timestamp) external;
    function chainId(uint256 newChainId) external;
}

contract WithdrawToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract AcceptAnyP256 {
    fallback() external {
        assembly {
            mstore(0, 1)
            return(0, 32)
        }
    }
}

contract PlanAccountWithdrawTest {
    VmWithdraw private constant VM = VmWithdraw(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant OWNER_KEY = 0xA11CE;
    address private constant RECIPIENT = address(0xBEEF);

    function _assert(bool condition, string memory message) private pure {
        require(condition, message);
    }

    function _sign(uint256 key, bytes32 digest) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = VM.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _setup() private returns (PlanAccount account, WithdrawToken token) {
        PlanBook book = new PlanBook(address(this), address(0x1002));
        account = new PlanAccount(address(book), VM.addr(OWNER_KEY));
        token = new WithdrawToken();
        token.mint(address(account), 10 ether);
    }

    function _reverts(PlanAccount account, address token, uint256 amount, uint64 deadline, bytes memory sig)
        private
        returns (bool)
    {
        (bool ok,) = address(account)
            .call(abi.encodeWithSelector(PlanAccount.withdraw.selector, token, RECIPIENT, amount, deadline, sig));
        return !ok;
    }

    function testOwnerSignatureMovesFundsOnceAnyoneCanRelay() external {
        (PlanAccount account, WithdrawToken token) = _setup();
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory sig = _sign(OWNER_KEY, account.withdrawDigest(address(token), RECIPIENT, 4 ether, 0, deadline));

        account.withdraw(address(token), RECIPIENT, 4 ether, deadline, sig);
        _assert(token.balanceOf(RECIPIENT) == 4 ether, "recipient not paid");
        _assert(token.balanceOf(address(account)) == 6 ether, "account not debited");
        _assert(account.withdrawNonce() == 1, "nonce not advanced");
        _assert(_reverts(account, address(token), 4 ether, deadline, sig), "signature replayed");
    }

    function testRefusesAStrangerAnExpiredSignatureAndAZeroRecipient() external {
        (PlanAccount account, WithdrawToken token) = _setup();
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory stranger = _sign(0xB0B, account.withdrawDigest(address(token), RECIPIENT, 1 ether, 0, deadline));
        _assert(_reverts(account, address(token), 1 ether, deadline, stranger), "stranger withdrew");

        bytes memory owner = _sign(OWNER_KEY, account.withdrawDigest(address(token), RECIPIENT, 1 ether, 0, deadline));
        _assert(_reverts(account, address(token), 2 ether, deadline, owner), "amount changed after signing");
        VM.warp(uint256(deadline) + 1);
        _assert(_reverts(account, address(token), 1 ether, deadline, owner), "expired signature accepted");

        (bool ok,) = address(account)
            .call(abi.encodeWithSelector(PlanAccount.withdraw.selector, address(token), address(0), 1, deadline, owner));
        _assert(!ok, "zero recipient accepted");
        _assert(token.balanceOf(address(account)) == 10 ether, "funds moved on a refusal");
    }

    function testSendsBnbWhenTokenIsZero() external {
        (PlanAccount account,) = _setup();
        VM.deal(address(account), 1 ether);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory sig = _sign(OWNER_KEY, account.withdrawDigest(address(0), RECIPIENT, 0.4 ether, 0, deadline));
        account.withdraw(address(0), RECIPIENT, 0.4 ether, deadline, sig);
        _assert(RECIPIENT.balance == 0.4 ether, "BNB not sent");
    }

    /// The browser builds this digest itself (apps/web/src/lib/passkey.ts withdrawDigest);
    /// the value below came from viem's hashTypedData for the same inputs on chain 56.
    function testWithdrawDigestMatchesTheBrowser() external {
        (PlanAccount account,) = _setup();
        address fixedAt = address(0xc0DE);
        VM.etch(fixedAt, address(account).code);
        VM.chainId(56);
        bytes32 digest = PlanAccount(payable(fixedAt))
            .withdrawDigest(0x55d398326f99059fF775485246999027B3197955, RECIPIENT, 5 ether, 3, 1791700000);
        _assert(
            digest == 0x06b2e958af2aa6e074854443025cc6aa0be576b3c7c335ff933490b172f3ff64,
            "contract and browser disagree on the withdraw digest"
        );
    }

    function testPasskeyOwnerCanWithdraw() external {
        VM.etch(address(0x100), address(new AcceptAnyP256()).code);
        PlanBook book = new PlanBook(address(this), address(0x1002));
        PasskeyOwner owner = new PasskeyOwner(bytes32(uint256(11)), bytes32(uint256(12)));
        PlanAccount account = new PlanAccount(address(book), address(owner));
        WithdrawToken token = new WithdrawToken();
        token.mint(address(account), 3 ether);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 digest = account.withdrawDigest(address(token), RECIPIENT, 3 ether, 0, deadline);
        string memory client = string.concat(
            "{\"type\":\"webauthn.get\",\"challenge\":\"",
            owner.challengeForDigest(digest),
            "\",\"origin\":\"https://theredeyed-agent.site\"}"
        );
        bytes memory authData = new bytes(37);
        authData[32] = 0x05;
        bytes memory assertion = abi.encode(bytes32(uint256(1)), bytes32(uint256(2)), 23, 1, authData, client);

        account.withdraw(address(token), RECIPIENT, 3 ether, deadline, assertion);
        _assert(token.balanceOf(RECIPIENT) == 3 ether, "passkey withdrawal failed");
    }
}
