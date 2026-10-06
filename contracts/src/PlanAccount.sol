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
    error TokenApprovalFailed();
    error RouterCallFailed(bytes reason);
    error ReentrantCall();

    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;
    address private constant P256_VERIFIER = address(0x100);
    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant PERMISSION_TYPEHASH = keccak256(
        "PlanPermission(bytes32 planHash,bytes32 standingRunHash,address agent,address tokenIn,address tokenOut,uint256 maxAmount,address router,uint64 notBefore,uint64 notAfter,uint256 maxPriceDeviationBps)"
    );
    bytes32 private constant CALL_TYPEHASH = keccak256(
        "PlanSwapCall(bytes32 permissionHash,bytes32 planHash,bytes32 eventKey,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint256 referenceAmountOut,uint256 value,bytes32 dataHash)"
    );

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

    event PermissionRevoked(bytes32 indexed permissionHash, address indexed owner);
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

    function permissionHash(Permission calldata permission) public pure returns (bytes32) {
        return _permissionHash(permission);
    }

    function permissionDigest(
        Permission calldata permission,
        SwapCall calldata swap
    ) public view returns (bytes32) {
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
        return keccak256(
            abi.encodePacked("\x19\x01", _domainSeparator(), callHash)
        );
    }

    function revoke(Permission calldata permission) external {
        if (msg.sender != accountOwner()) revert NotOwner();
        bytes32 hash = _permissionHash(permission);
        revoked[hash] = true;
        emit PermissionRevoked(hash, accountOwner());
    }

    /// @notice Executes the exact call signed for a plan permission.
    /// @dev The router calldata is part of the signed digest. The account also
    ///      checks the token pair, amount cap, signed output band and deadline.
    function executeSwap(
        Permission calldata permission,
        bytes calldata signature,
        SwapCall calldata swap
    ) external payable returns (bytes memory result) {
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
        uint256 minimumAllowed =
            (swap.referenceAmountOut * (10_000 - permission.maxPriceDeviationBps) + 9_999) / 10_000;
        if (swap.minAmountOut < minimumAllowed) revert InvalidPriceBand();
        if (swap.value != msg.value) revert NativeValueMismatch();
        if (permission.tokenIn != address(0) && swap.value != 0) revert NativeValueMismatch();

        bytes32 permissionHashValue = _permissionHash(permission);
        if (revoked[permissionHashValue]) revert PermissionIsRevoked();
        bytes32 useKey = permissionHashValue;
        if (permission.standingRunHash == bytes32(0)) {
            if (swap.planHash != permission.planHash) revert PlanNotFrozen();
            if (!planBook.isPlanHashActive(accountOwner(), permission.planHash)) revert PlanNotFrozen();
            if (used[permissionHashValue]) revert PermissionAlreadyUsed();
        } else {
            if (
                !planBook.isStandingPlanForRunAndEvent(
                    accountOwner(), permission.standingRunHash, swap.planHash, swap.eventKey
                )
            ) revert PlanNotFrozen();
            useKey = keccak256(abi.encode(permissionHashValue, swap.eventKey));
            if (usedForWindow[useKey]) revert PermissionAlreadyUsed();
        }

        bytes32 digest = permissionDigest(permission, swap);
        if (!_validOwnerSignature(digest, signature)) revert InvalidSignature();
        if (executing) revert ReentrantCall();
        executing = true;
        if (permission.standingRunHash == bytes32(0)) used[permissionHashValue] = true;
        else usedForWindow[useKey] = true;
        emit PermissionUsed(permissionHashValue, digest);

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

    function _permissionHash(Permission calldata permission) private pure returns (bytes32) {
        return
            keccak256(
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
        return
            keccak256(
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

        (bool passkeyOk, bytes memory passkeyResult) = P256_VERIFIER.staticcall(
            abi.encode(digest, signature)
        );
        if (
            passkeyOk &&
            passkeyResult.length >= 32 &&
            abi.decode(passkeyResult, (uint256)) == 1
        ) return true;

        if (owner.code.length > 0) {
            (bool contractOk, bytes memory contractResult) = owner.staticcall(
                abi.encodeWithSelector(IERC1271PlanAccount.isValidSignature.selector, digest, signature)
            );
            if (
                contractOk &&
                contractResult.length >= 32 &&
                abi.decode(contractResult, (bytes4)) == ERC1271_MAGIC
            ) return true;
        }
        return false;
    }

    function _approveExact(address token, address spender, uint256 amount) private {
        (bool success, bytes memory returned) = token.call(
            abi.encodeWithSelector(IERC20PlanAccount.approve.selector, spender, amount)
        );
        if (!success || (returned.length > 0 && !abi.decode(returned, (bool)))) {
            revert TokenApprovalFailed();
        }
    }
}
