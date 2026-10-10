// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPlanBook {
    function isPlanHashActive(address planOwner, bytes32 planHash) external view returns (bool);
    function isStandingPlanForRunAndEvent(
        address planOwner,
        bytes32 standingRunHash,
        bytes32 planHash,
        bytes32 eventKey
    ) external view returns (bool);
}

interface IERC20PlanAccount {
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IERC1271PlanAccount {
    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4);
}

/// @notice Executes one owner-signed, bounded swap for one frozen Redeye plan.
/// @dev The zero-owner constructor mode is suitable as EIP-7702 delegated code:
///      the delegated account address becomes its owner. A deployed instance can
///      use an explicit owner for a passkey account or a regular wallet account.
contract PlanAccount {
    error NotAgent();
    error NotOwner();
    error ZeroAddress();
    error ZeroHash();
    error InvalidPermissionWindow();
    error PermissionExpired();
    error PermissionIsRevoked();
    error PermissionAlreadyUsed();
    error PlanNotFrozen();
    error InvalidStandingPermission();
    error InvalidSignature();
    error TokenPairMismatch();
    error RouterMismatch();
    error AmountExceeded();
    error NativeValueMismatch();
    error InvalidPriceBand();
    error InvalidRouterCall();
    error TokenApprovalFailed();
    error RouterCallFailed(bytes reason);
    error ReentrantCall();
    error WithdrawExpired();
    error TransferFailed();

    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant PERMISSION_TYPEHASH = keccak256(
        "PlanPermission(bytes32 planHash,bytes32 standingRunHash,address agent,address tokenIn,address tokenOut,uint256 maxAmount,address router,uint64 notBefore,uint64 notAfter,uint256 maxPriceDeviationBps)"
    );
    bytes32 private constant WITHDRAW_TYPEHASH =
        keccak256("Withdraw(address token,address to,uint256 amount,uint256 nonce,uint64 deadline)");
    bytes32 private constant CALL_TYPEHASH = keccak256(
        "PlanSwapCall(bytes32 permissionHash,bytes32 planHash,bytes32 eventKey,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint256 referenceAmountOut,uint256 value,bytes32 dataHash)"
    );
    // The approved v1.8 adapter currently emits Pancake V3 SmartRouter's
    // exactInputSingle calldata. Do not forward arbitrary router methods from
    // an owner-signed permission: that would let the agent change the recipient
    // or invoke approvals/multicalls while keeping the same token pair.
    bytes4 private constant EXACT_INPUT_SINGLE_SELECTOR = 0x04e45aaf;

    struct Permission {
        bytes32 planHash;
        bytes32 standingRunHash;
        address agent;
        address tokenIn;
        address tokenOut;
        uint256 maxAmount;
        address router;
        uint64 notBefore;
        uint64 notAfter;
        uint256 maxPriceDeviationBps;
    }

    struct SwapCall {
        bytes32 planHash;
        bytes32 eventKey;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        uint256 referenceAmountOut;
        uint256 value;
        bytes data;
    }

    IPlanBook public immutable planBook;
    address private immutable configuredOwner;
    bool private executing;

    mapping(bytes32 => bool) public revoked;
    mapping(bytes32 => bool) public used;
    mapping(bytes32 => bool) public usedForWindow;
    /// @notice Counts owner-signed withdrawals, so each signature moves funds once.
    uint256 public withdrawNonce;

    event PermissionRevoked(bytes32 indexed permissionHash, address indexed owner);
    event Withdrawn(address indexed token, address indexed to, uint256 amount, uint256 nonce);
    event PermissionUsed(bytes32 indexed permissionHash, bytes32 indexed callHash);
    event SwapExecuted(
        bytes32 indexed permissionHash,
        address indexed router,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMinimum
    );

    constructor(address planBookAddress, address initialOwner) {
        if (planBookAddress == address(0)) revert ZeroAddress();
        planBook = IPlanBook(planBookAddress);
        configuredOwner = initialOwner;
    }

    function accountOwner() public view returns (address) {
        return configuredOwner == address(0) ? address(this) : configuredOwner;
    }

    /// @notice The address that holds funds and owns PlanBook records.
    /// @dev In delegated mode this is the EOA. For a deployed passkey account it
    ///      is this contract, while accountOwner() is the credential verifier.
    function accountAddress() public view returns (address) {
        return address(this);
    }

    function permissionHash(Permission calldata permission) public pure returns (bytes32) {
        return _permissionHash(permission);
    }

    /// @notice Returns the EIP-712 digest the owner signs once for a permission.
    /// @dev The permission deliberately excludes live quote/router calldata. The
    ///      account checks the eventual call against these bounds on chain.
    function permissionDigest(Permission calldata permission) public view returns (bytes32) {
        bytes32 permissionHashValue = _permissionHash(permission);
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), permissionHashValue));
    }

    /// @notice Returns the digest of a concrete call for audit tooling.
    /// @dev This is not the execution authorization. Owners sign the bounded
    ///      permission digest above; the call is validated separately below.
    function callDigest(Permission calldata permission, SwapCall calldata swap) public view returns (bytes32) {
        bytes32 permissionHashValue = _permissionHash(permission);
        bytes32 callHash = keccak256(
            abi.encode(
                CALL_TYPEHASH,
                permissionHashValue,
                swap.planHash,
                swap.eventKey,
                swap.tokenIn,
                swap.tokenOut,
                swap.amountIn,
                swap.minAmountOut,
                swap.referenceAmountOut,
                swap.value,
                keccak256(swap.data)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), callHash));
    }

    function revoke(Permission calldata permission) external {
        if (msg.sender != accountOwner()) revert NotOwner();
        bytes32 hash = _permissionHash(permission);
        revoked[hash] = true;
        emit PermissionRevoked(hash, accountOwner());
    }

    /// @notice Executes one call covered by an owner-signed plan permission.
    /// @dev The account checks the live router calldata's token pair, amount cap,
    ///      output band, frozen plan/window, and deadline on chain. This lets the
    ///      agent obtain a fresh quote after the permission is signed without
    ///      giving it authority outside the owner's explicit bounds.
    function executeSwap(Permission calldata permission, bytes calldata signature, SwapCall calldata swap)
        external
        payable
        returns (bytes memory result)
    {
        if (msg.sender != permission.agent) revert NotAgent();
        if (permission.agent == address(0) || permission.router == address(0)) revert ZeroAddress();
        if (permission.planHash == bytes32(0) && permission.standingRunHash == bytes32(0)) revert ZeroHash();
        if (permission.planHash != bytes32(0) && permission.standingRunHash != bytes32(0)) {
            revert InvalidStandingPermission();
        }
        if (permission.notAfter < permission.notBefore) revert InvalidPermissionWindow();
        if (block.timestamp < permission.notBefore || block.timestamp > permission.notAfter) {
            revert PermissionExpired();
        }
        if (permission.maxPriceDeviationBps > 10_000) revert InvalidPriceBand();
        if (swap.tokenIn != permission.tokenIn || swap.tokenOut != permission.tokenOut) {
            revert TokenPairMismatch();
        }
        if (swap.amountIn == 0 || swap.amountIn > permission.maxAmount) revert AmountExceeded();
        if (swap.referenceAmountOut == 0) revert InvalidPriceBand();
        uint256 minimumAllowed = (swap.referenceAmountOut * (10_000 - permission.maxPriceDeviationBps) + 9_999) / 10_000;
        if (swap.minAmountOut < minimumAllowed) revert InvalidPriceBand();
        if (swap.value != msg.value) revert NativeValueMismatch();
        if (permission.tokenIn != address(0) && swap.value != 0) revert NativeValueMismatch();
        _validateRouterCall(permission, swap);

        bytes32 permissionHashValue = _permissionHash(permission);
        if (revoked[permissionHashValue]) revert PermissionIsRevoked();
        bytes32 useKey = permissionHashValue;
        if (permission.standingRunHash == bytes32(0)) {
            if (swap.planHash != permission.planHash) revert PlanNotFrozen();
            if (!planBook.isPlanHashActive(accountAddress(), permission.planHash)) revert PlanNotFrozen();
            if (used[permissionHashValue]) revert PermissionAlreadyUsed();
        } else {
            if (!planBook.isStandingPlanForRunAndEvent(
                    accountAddress(), permission.standingRunHash, swap.planHash, swap.eventKey
                )) revert PlanNotFrozen();
            useKey = keccak256(abi.encode(permissionHashValue, swap.eventKey));
            if (usedForWindow[useKey]) revert PermissionAlreadyUsed();
        }

        bytes32 digest = permissionDigest(permission);
        if (!_validOwnerSignature(digest, signature)) revert InvalidSignature();
        if (executing) revert ReentrantCall();
        executing = true;
        if (permission.standingRunHash == bytes32(0)) used[permissionHashValue] = true;
        else usedForWindow[useKey] = true;
        emit PermissionUsed(permissionHashValue, callDigest(permission, swap));

        if (permission.tokenIn != address(0)) {
            _approveExact(permission.tokenIn, permission.router, swap.amountIn);
        }
        (bool success, bytes memory returned) = permission.router.call{value: swap.value}(swap.data);
        if (!success) revert RouterCallFailed(returned);
        if (permission.tokenIn != address(0)) {
            _approveExact(permission.tokenIn, permission.router, 0);
        }
        executing = false;
        emit SwapExecuted(
            permissionHashValue,
            permission.router,
            permission.tokenIn,
            permission.tokenOut,
            swap.amountIn,
            swap.minAmountOut
        );
        return returned;
    }

    /// @notice Returns the EIP-712 digest the owner signs to move funds out of the account.
    function withdrawDigest(address token, address to, uint256 amount, uint256 nonce, uint64 deadline)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(WITHDRAW_TYPEHASH, token, to, amount, nonce, deadline));
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    /// @notice Moves funds out on the owner's signature; anyone may relay it and pay the gas.
    /// @dev A deployed passkey account has no key that can send transactions, so without this
    ///      its funds could only ever be swapped inside it. token = address(0) sends BNB.
    function withdraw(address token, address to, uint256 amount, uint64 deadline, bytes calldata signature) external {
        if (to == address(0)) revert ZeroAddress();
        if (block.timestamp > deadline) revert WithdrawExpired();
        uint256 nonce = withdrawNonce;
        if (!_validOwnerSignature(withdrawDigest(token, to, amount, nonce, deadline), signature)) {
            revert InvalidSignature();
        }
        if (executing) revert ReentrantCall();
        withdrawNonce = nonce + 1;
        emit Withdrawn(token, to, amount, nonce);
        if (token == address(0)) {
            (bool sent,) = to.call{value: amount}("");
            if (!sent) revert TransferFailed();
        } else {
            (bool success, bytes memory returned) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
            if (!success || (returned.length > 0 && !abi.decode(returned, (bool)))) revert TransferFailed();
        }
    }

    receive() external payable {}

    function _permissionHash(Permission calldata permission) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                PERMISSION_TYPEHASH,
                permission.planHash,
                permission.standingRunHash,
                permission.agent,
                permission.tokenIn,
                permission.tokenOut,
                permission.maxAmount,
                permission.router,
                permission.notBefore,
                permission.notAfter,
                permission.maxPriceDeviationBps
            )
        );
    }

    function _domainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes("Redeye PlanAccount")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    function _validOwnerSignature(bytes32 digest, bytes calldata signature) private view returns (bool) {
        address owner = accountOwner();
        if (signature.length == 65) {
            bytes32 r;
            bytes32 s;
            uint8 v;
            assembly {
                r := calldataload(signature.offset)
                s := calldataload(add(signature.offset, 32))
                v := byte(0, calldataload(add(signature.offset, 64)))
            }
            if (v < 27) v += 27;
            if (v == 27 || v == 28) {
                address recovered = ecrecover(digest, v, r, s);
                if (recovered == owner) return true;
            }
        }

        if (owner.code.length > 0) {
            (bool contractOk, bytes memory contractResult) = owner.staticcall(
                abi.encodeWithSelector(IERC1271PlanAccount.isValidSignature.selector, digest, signature)
            );
            if (contractOk && contractResult.length >= 32 && abi.decode(contractResult, (bytes4)) == ERC1271_MAGIC) {
                return true;
            }
        }
        return false;
    }

    function _approveExact(address token, address spender, uint256 amount) private {
        (bool success, bytes memory returned) =
            token.call(abi.encodeWithSelector(IERC20PlanAccount.approve.selector, spender, amount));
        if (!success || (returned.length > 0 && !abi.decode(returned, (bool)))) {
            revert TokenApprovalFailed();
        }
    }

    function _validateRouterCall(Permission calldata permission, SwapCall calldata swap) private view {
        if (swap.data.length < 4) revert InvalidRouterCall();
        bytes calldata data = swap.data;
        bytes4 selector;
        assembly {
            selector := calldataload(data.offset)
        }
        if (selector != EXACT_INPUT_SINGLE_SELECTOR) revert InvalidRouterCall();

        (
            address tokenIn,
            address tokenOut,
            uint24 fee,
            address recipient,
            uint256 amountIn,
            uint256 amountOutMinimum,
            uint160 sqrtPriceLimitX96
        ) = abi.decode(swap.data[4:], (address, address, uint24, address, uint256, uint256, uint160));
        fee;
        sqrtPriceLimitX96;
        if (
            tokenIn != permission.tokenIn || tokenOut != permission.tokenOut || recipient != accountAddress()
                || amountIn != swap.amountIn || amountOutMinimum != swap.minAmountOut || sqrtPriceLimitX96 != 0
        ) revert InvalidRouterCall();
    }
}
