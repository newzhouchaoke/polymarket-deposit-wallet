// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1271} from "@solady/src/accounts/ERC1271.sol";

/*
 * Research-only implementation inspired by Polymarket's public architecture.
 *
 * Important:
 * - This is not Polymarket's production code.
 * - The Deposit Wallet uses Solady's ERC-7739 implementation.
 * - The exact public CTF Exchange V2, Safe derivation, proxy derivation and
 *   negative-risk adapters are pinned separately under official/.
 * - Deploy only to a test network until it has received an independent audit.
 */

interface IERC1271Like {
    function isValidSignature(bytes32 hash, bytes calldata signature)
        external
        view
        returns (bytes4);
}

interface IERC1155ReceiverLike {
    function onERC1155Received(
        address operator,
        address from,
        uint256 id,
        uint256 value,
        bytes calldata data
    ) external returns (bytes4);

    function onERC1155BatchReceived(
        address operator,
        address from,
        uint256[] calldata ids,
        uint256[] calldata values,
        bytes calldata data
    ) external returns (bytes4);
}

interface IResearchDepositWalletFactory {
    function getWallet(address owner) external view returns (address);
}

abstract contract ResearchERC20 {
    string public name;
    string public symbol;
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    address public immutable owner;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Transfer(address indexed from, address indexed to, uint256 value);

    error InvalidAddress();
    error InsufficientBalance();
    error InsufficientAllowance();
    error NotOwner();

    constructor(string memory name_, string memory symbol_) {
        name = name_;
        symbol = symbol_;
        owner = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        if (to == address(0)) revert InvalidAddress();
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount)
        external
        returns (bool)
    {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < amount) revert InsufficientAllowance();
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
            emit Approval(from, msg.sender, allowance[from][msg.sender]);
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        if (to == address(0)) revert InvalidAddress();
        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = balance - amount;
        }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @notice Legacy-compatible test collateral used by the standalone deploy script.
contract ResearchMockUSD is ResearchERC20 {
    constructor() ResearchERC20("Research Mock USD", "rUSD") {}
}

/// @notice The project's primary six-decimal research collateral token.
contract ResearchWalletCoin is ResearchERC20 {
    constructor() ResearchERC20("Research Wallet Coin", "rWALLET") {}
}

/**
 * @notice Binary Conditional Tokens research implementation.
 * @dev Uses ERC-1155-compatible transfer methods and implements the important
 *      CTF lifecycle: prepare, split, merge, report payouts and redeem.
 */
contract ResearchOutcomeToken {
    struct Condition {
        address oracle;
        bytes32 questionId;
        uint8 outcomeSlotCount;
        bool resolved;
    }

    ResearchERC20 public immutable collateral;
    address public admin;
    address public exchange;
    uint256 public collateralizedSupply;

    mapping(bytes32 => Condition) public conditions;
    mapping(bytes32 => uint256) public payoutDenominator;
    mapping(bytes32 => mapping(uint256 => uint256)) public payoutNumerators;
    mapping(uint256 => bytes32) public conditionOfToken;
    mapping(bytes32 => uint256) public yesTokenId;
    mapping(bytes32 => uint256) public noTokenId;
    mapping(address => mapping(uint256 => uint256)) private balances;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    event ConditionPreparation(
        bytes32 indexed conditionId,
        address indexed oracle,
        bytes32 indexed questionId,
        uint256 outcomeSlotCount
    );
    event ConditionResolution(
        bytes32 indexed conditionId,
        address indexed oracle,
        bytes32 indexed questionId,
        uint256[] payoutNumerators
    );
    event PositionSplit(
        address indexed stakeholder,
        bytes32 indexed conditionId,
        uint256 amount
    );
    event PositionsMerge(
        address indexed stakeholder,
        bytes32 indexed conditionId,
        uint256 amount
    );
    event PayoutRedemption(
        address indexed redeemer,
        bytes32 indexed conditionId,
        uint256 payout
    );
    event TransferSingle(
        address indexed operator,
        address indexed from,
        address indexed to,
        uint256 id,
        uint256 value
    );
    event TransferBatch(
        address indexed operator,
        address indexed from,
        address indexed to,
        uint256[] ids,
        uint256[] values
    );
    event ApprovalForAll(
        address indexed account,
        address indexed operator,
        bool approved
    );
    event URI(string value, uint256 indexed id);
    event ExchangeChanged(address indexed exchange);

    error AlreadyPrepared();
    error AlreadyResolved();
    error ArrayLengthMismatch();
    error ConditionNotPrepared();
    error ConditionNotResolved();
    error InsufficientBalance();
    error InsufficientCollateralBacking();
    error InvalidAddress();
    error InvalidOutcomeCount();
    error InvalidPayout();
    error NotAdmin();
    error NotApproved();
    error NotExchange();
    error TokenTransferFailed();
    error UnsafeRecipient();

    constructor(address collateral_) {
        if (collateral_ == address(0)) revert InvalidAddress();
        collateral = ResearchERC20(collateral_);
        admin = msg.sender;
    }

    function setExchange(address exchange_) external {
        if (msg.sender != admin) revert NotAdmin();
        if (exchange_ == address(0)) revert InvalidAddress();
        exchange = exchange_;
        emit ExchangeChanged(exchange_);
    }

    function getConditionId(
        address oracle,
        bytes32 questionId,
        uint256 outcomeSlotCount
    ) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(oracle, questionId, outcomeSlotCount));
    }

    function getPositionId(bytes32 conditionId, uint256 indexSet)
        public
        view
        returns (uint256)
    {
        return uint256(
            keccak256(abi.encodePacked(address(collateral), conditionId, indexSet))
        );
    }

    function prepareCondition(
        address oracle,
        bytes32 questionId,
        uint256 outcomeSlotCount
    ) public returns (bytes32 conditionId) {
        if (oracle == address(0)) revert InvalidAddress();
        if (outcomeSlotCount != 2) revert InvalidOutcomeCount();
        conditionId = getConditionId(oracle, questionId, outcomeSlotCount);
        if (conditions[conditionId].oracle != address(0)) revert AlreadyPrepared();

        conditions[conditionId] = Condition({
            oracle: oracle,
            questionId: questionId,
            outcomeSlotCount: uint8(outcomeSlotCount),
            resolved: false
        });
        uint256 yes = getPositionId(conditionId, 1);
        uint256 no = getPositionId(conditionId, 2);
        yesTokenId[conditionId] = yes;
        noTokenId[conditionId] = no;
        conditionOfToken[yes] = conditionId;
        conditionOfToken[no] = conditionId;

        emit ConditionPreparation(
            conditionId,
            oracle,
            questionId,
            outcomeSlotCount
        );
    }

    function reportPayouts(
        bytes32 questionId,
        uint256[] calldata payouts
    ) external {
        if (payouts.length != 2) revert InvalidOutcomeCount();
        bytes32 conditionId = getConditionId(msg.sender, questionId, 2);
        Condition storage condition = conditions[conditionId];
        if (condition.oracle == address(0)) revert ConditionNotPrepared();
        if (condition.resolved) revert AlreadyResolved();

        uint256 denominator = payouts[0] + payouts[1];
        if (denominator == 0) revert InvalidPayout();
        payoutNumerators[conditionId][0] = payouts[0];
        payoutNumerators[conditionId][1] = payouts[1];
        payoutDenominator[conditionId] = denominator;
        condition.resolved = true;
        emit ConditionResolution(conditionId, msg.sender, questionId, payouts);
    }

    function splitPosition(bytes32 conditionId, uint256 amount) external {
        _requirePrepared(conditionId);
        if (amount == 0) revert InvalidPayout();
        if (!collateral.transferFrom(msg.sender, address(this), amount)) {
            revert TokenTransferFailed();
        }
        collateralizedSupply += amount;
        _mint(msg.sender, yesTokenId[conditionId], amount, "");
        _mint(msg.sender, noTokenId[conditionId], amount, "");
        emit PositionSplit(msg.sender, conditionId, amount);
    }

    function mergePositions(bytes32 conditionId, uint256 amount) external {
        _requirePrepared(conditionId);
        if (amount == 0) revert InvalidPayout();
        _burn(msg.sender, yesTokenId[conditionId], amount);
        _burn(msg.sender, noTokenId[conditionId], amount);
        collateralizedSupply -= amount;
        if (!collateral.transfer(msg.sender, amount)) revert TokenTransferFailed();
        emit PositionsMerge(msg.sender, conditionId, amount);
    }

    function redeemPositions(bytes32 conditionId)
        external
        returns (uint256 payout)
    {
        Condition storage condition = conditions[conditionId];
        if (!condition.resolved) revert ConditionNotResolved();
        uint256 denominator = payoutDenominator[conditionId];
        uint256 yes = yesTokenId[conditionId];
        uint256 no = noTokenId[conditionId];
        uint256 yesBalance = balances[msg.sender][yes];
        uint256 noBalance = balances[msg.sender][no];

        if (yesBalance > 0) _burn(msg.sender, yes, yesBalance);
        if (noBalance > 0) _burn(msg.sender, no, noBalance);
        payout =
            (
                yesBalance * payoutNumerators[conditionId][0]
                    + noBalance * payoutNumerators[conditionId][1]
            ) / denominator;
        collateralizedSupply -= payout;
        if (payout > 0 && !collateral.transfer(msg.sender, payout)) {
            revert TokenTransferFailed();
        }
        emit PayoutRedemption(msg.sender, conditionId, payout);
    }

    /// @dev Exchange hook used for the BUY+BUY MINT settlement path.
    function exchangeMintCompleteSet(
        bytes32 conditionId,
        address to,
        uint256 amount
    ) external {
        if (msg.sender != exchange) revert NotExchange();
        _requirePrepared(conditionId);
        if (
            collateral.balanceOf(address(this))
                < collateralizedSupply + amount
        ) revert InsufficientCollateralBacking();
        collateralizedSupply += amount;
        _mint(to, yesTokenId[conditionId], amount, "");
        _mint(to, noTokenId[conditionId], amount, "");
        emit PositionSplit(to, conditionId, amount);
    }

    /// @dev Exchange hook used for the SELL+SELL MERGE settlement path.
    function exchangeMergeCompleteSet(
        bytes32 conditionId,
        address from,
        address recipient,
        uint256 amount
    ) external {
        if (msg.sender != exchange) revert NotExchange();
        _requirePrepared(conditionId);
        _burn(from, yesTokenId[conditionId], amount);
        _burn(from, noTokenId[conditionId], amount);
        collateralizedSupply -= amount;
        if (!collateral.transfer(recipient, amount)) revert TokenTransferFailed();
        emit PositionsMerge(from, conditionId, amount);
    }

    function balanceOf(address account, uint256 id)
        public
        view
        returns (uint256)
    {
        if (account == address(0)) revert InvalidAddress();
        return balances[account][id];
    }

    function balanceOfBatch(
        address[] calldata accounts,
        uint256[] calldata ids
    ) external view returns (uint256[] memory result) {
        if (accounts.length != ids.length) revert ArrayLengthMismatch();
        result = new uint256[](accounts.length);
        for (uint256 i; i < accounts.length; ++i) {
            result[i] = balanceOf(accounts[i], ids[i]);
        }
    }

    function setApprovalForAll(address operator, bool approved) external {
        if (operator == msg.sender) revert NotApproved();
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function safeTransferFrom(
        address from,
        address to,
        uint256 id,
        uint256 amount,
        bytes calldata data
    ) public {
        if (msg.sender != from && !isApprovedForAll[from][msg.sender]) {
            revert NotApproved();
        }
        _transfer(from, to, id, amount, data);
    }

    function safeBatchTransferFrom(
        address from,
        address to,
        uint256[] calldata ids,
        uint256[] calldata amounts,
        bytes calldata data
    ) external {
        if (ids.length != amounts.length) revert ArrayLengthMismatch();
        if (msg.sender != from && !isApprovedForAll[from][msg.sender]) {
            revert NotApproved();
        }
        if (to == address(0)) revert InvalidAddress();
        for (uint256 i; i < ids.length; ++i) {
            _move(from, to, ids[i], amounts[i]);
        }
        emit TransferBatch(msg.sender, from, to, ids, amounts);
        if (
            to.code.length > 0
                && IERC1155ReceiverLike(to).onERC1155BatchReceived(
                    msg.sender, from, ids, amounts, data
                ) != IERC1155ReceiverLike.onERC1155BatchReceived.selector
        ) revert UnsafeRecipient();
    }

    function supportsInterface(bytes4 interfaceId)
        external
        pure
        returns (bool)
    {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0xd9b67a26;
    }

    function _transfer(
        address from,
        address to,
        uint256 id,
        uint256 amount,
        bytes memory data
    ) internal {
        if (to == address(0)) revert InvalidAddress();
        _move(from, to, id, amount);
        emit TransferSingle(msg.sender, from, to, id, amount);
        if (
            to.code.length > 0
                && IERC1155ReceiverLike(to).onERC1155Received(
                    msg.sender, from, id, amount, data
                ) != IERC1155ReceiverLike.onERC1155Received.selector
        ) revert UnsafeRecipient();
    }

    function _move(address from, address to, uint256 id, uint256 amount)
        internal
    {
        uint256 balance = balances[from][id];
        if (balance < amount) revert InsufficientBalance();
        unchecked {
            balances[from][id] = balance - amount;
        }
        balances[to][id] += amount;
    }

    function _mint(
        address to,
        uint256 id,
        uint256 amount,
        bytes memory data
    ) internal {
        if (to == address(0)) revert InvalidAddress();
        balances[to][id] += amount;
        emit TransferSingle(msg.sender, address(0), to, id, amount);
        if (
            to.code.length > 0
                && IERC1155ReceiverLike(to).onERC1155Received(
                    msg.sender, address(0), id, amount, data
                ) != IERC1155ReceiverLike.onERC1155Received.selector
        ) revert UnsafeRecipient();
    }

    function _burn(address from, uint256 id, uint256 amount) internal {
        uint256 balance = balances[from][id];
        if (balance < amount) revert InsufficientBalance();
        unchecked {
            balances[from][id] = balance - amount;
        }
        emit TransferSingle(msg.sender, from, address(0), id, amount);
    }

    function _requirePrepared(bytes32 conditionId) internal view {
        if (conditions[conditionId].oracle == address(0)) {
            revert ConditionNotPrepared();
        }
    }
}

/// @notice Market metadata and oracle adapter for binary research markets.
contract ResearchMarketRegistry {
    enum MarketStatus {
        OPEN,
        CLOSED,
        RESOLVED
    }

    struct Market {
        bytes32 marketId;
        bytes32 questionId;
        bytes32 conditionId;
        address creator;
        string question;
        uint256 yesTokenId;
        uint256 noTokenId;
        uint64 closeTime;
        MarketStatus status;
        uint8 winningOutcome;
    }

    ResearchOutcomeToken public immutable outcome;
    address public operator;
    uint256 public marketCount;
    mapping(bytes32 => Market) public markets;

    event MarketPublished(
        bytes32 indexed marketId,
        bytes32 indexed conditionId,
        address indexed creator,
        string question,
        uint256 yesTokenId,
        uint256 noTokenId,
        uint64 closeTime
    );
    event MarketClosed(bytes32 indexed marketId);
    event MarketResolved(bytes32 indexed marketId, uint8 winningOutcome);
    event OperatorChanged(address indexed operator);

    error AlreadyResolved();
    error InvalidAddress();
    error InvalidCloseTime();
    error InvalidOutcome();
    error MarketNotOpen();
    error NotCreatorOrOperator();
    error NotOperator();
    error UnknownMarket();

    constructor(address outcome_) {
        if (outcome_ == address(0)) revert InvalidAddress();
        outcome = ResearchOutcomeToken(outcome_);
        operator = msg.sender;
    }

    function setOperator(address operator_) external {
        if (msg.sender != operator) revert NotOperator();
        if (operator_ == address(0)) revert InvalidAddress();
        operator = operator_;
        emit OperatorChanged(operator_);
    }

    function nextMarket(
        address creator,
        string calldata question,
        uint64 closeTime
    )
        public
        view
        returns (
            bytes32 marketId,
            bytes32 questionId,
            bytes32 conditionId,
            uint256 yes,
            uint256 no
        )
    {
        questionId = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                creator,
                marketCount,
                question,
                closeTime
            )
        );
        conditionId = outcome.getConditionId(address(this), questionId, 2);
        marketId = conditionId;
        yes = outcome.getPositionId(conditionId, 1);
        no = outcome.getPositionId(conditionId, 2);
    }

    function publishMarket(string calldata question, uint64 closeTime)
        external
        returns (
            bytes32 marketId,
            bytes32 conditionId,
            uint256 yes,
            uint256 no
        )
    {
        if (closeTime != 0 && closeTime <= block.timestamp) {
            revert InvalidCloseTime();
        }
        bytes32 questionId;
        (marketId, questionId, conditionId, yes, no) =
            nextMarket(msg.sender, question, closeTime);
        marketCount += 1;
        outcome.prepareCondition(address(this), questionId, 2);
        markets[marketId] = Market({
            marketId: marketId,
            questionId: questionId,
            conditionId: conditionId,
            creator: msg.sender,
            question: question,
            yesTokenId: yes,
            noTokenId: no,
            closeTime: closeTime,
            status: MarketStatus.OPEN,
            winningOutcome: 0
        });
        emit MarketPublished(
            marketId,
            conditionId,
            msg.sender,
            question,
            yes,
            no,
            closeTime
        );
    }

    function closeMarket(bytes32 marketId) external {
        Market storage market = markets[marketId];
        _requireMarketAuthority(market);
        if (market.status != MarketStatus.OPEN) revert MarketNotOpen();
        market.status = MarketStatus.CLOSED;
        emit MarketClosed(marketId);
    }

    function resolveMarket(bytes32 marketId, uint8 winningOutcome) external {
        Market storage market = markets[marketId];
        _requireMarketAuthority(market);
        if (market.status == MarketStatus.RESOLVED) revert AlreadyResolved();
        if (winningOutcome != 1 && winningOutcome != 2) revert InvalidOutcome();

        market.status = MarketStatus.RESOLVED;
        market.winningOutcome = winningOutcome;
        uint256[] memory payouts = new uint256[](2);
        payouts[winningOutcome - 1] = 1;
        outcome.reportPayouts(market.questionId, payouts);
        emit MarketResolved(marketId, winningOutcome);
    }

    function isOpen(bytes32 marketId) external view returns (bool) {
        Market storage market = markets[marketId];
        return market.creator != address(0)
            && market.status == MarketStatus.OPEN
            && (market.closeTime == 0 || block.timestamp <= market.closeTime);
    }

    function _requireMarketAuthority(Market storage market) internal view {
        if (market.creator == address(0)) revert UnknownMarket();
        if (msg.sender != market.creator && msg.sender != operator) {
            revert NotCreatorOrOperator();
        }
    }
}

/**
 * @notice Research Deposit Wallet implementation used behind beacon proxies.
 * @dev Batch type follows the public Deposit Wallet EIP-712 shape. ERC-1271
 *      uses the ERC-7739 nested typed-data workflow implemented by Solady.
 */
contract ResearchDepositWallet is ERC1271 {
    bytes32 public constant CALL_TYPEHASH =
        keccak256("Call(address target,uint256 value,bytes data)");
    bytes32 public constant BATCH_TYPEHASH = keccak256(
        "Batch(address wallet,uint256 nonce,uint256 deadline,Call[] calls)Call(address target,uint256 value,bytes data)"
    );

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    address public owner;
    address public factory;
    uint256 public nonce;
    bool public paused;
    bool private initialized;
    mapping(address => bool) public sessionSigner;

    event BatchExecuted(
        bytes32 indexed batchHash,
        uint256 indexed nonce,
        address indexed executor,
        uint256 callCount
    );
    event Paused(address indexed account);
    event SessionSignerChanged(address indexed signer, bool approved);
    event Unpaused(address indexed account);

    error BatchExpired();
    error CallFailed(uint256 index, bytes reason);
    error InvalidAddress();
    error InvalidNonce();
    error InvalidSignature();
    error NotOwner();
    error WalletAlreadyInitialized();
    error WalletPaused();

    receive() external payable {}

    function initialize(address owner_, address factory_) external {
        if (initialized) revert WalletAlreadyInitialized();
        if (owner_ == address(0) || factory_ == address(0)) {
            revert InvalidAddress();
        }
        initialized = true;
        owner = owner_;
        factory = factory_;
    }

    /// @notice Relayer-style execution using the official public Batch shape.
    function executeBatch(
        Call[] calldata calls,
        uint256 expectedNonce,
        uint256 deadline,
        bytes calldata signature
    ) external payable returns (bytes[] memory results) {
        if (paused) revert WalletPaused();
        if (deadline < block.timestamp) revert BatchExpired();
        if (expectedNonce != nonce) revert InvalidNonce();
        bytes32 digest = hashBatch(calls, expectedNonce, deadline);
        address recovered = _recover(digest, signature);
        if (recovered != owner && !sessionSigner[recovered]) {
            revert InvalidSignature();
        }
        nonce = expectedNonce + 1;
        results = _execute(calls);
        emit BatchExecuted(digest, expectedNonce, msg.sender, calls.length);
    }

    /// @notice Research convenience path; production relayers use signed batches.
    function executeBatch(Call[] calldata calls)
        external
        payable
        returns (bytes[] memory results)
    {
        if (msg.sender != owner) revert NotOwner();
        if (paused) revert WalletPaused();
        uint256 currentNonce = nonce++;
        results = _execute(calls);
        emit BatchExecuted(bytes32(0), currentNonce, msg.sender, calls.length);
    }

    function setSessionSigner(address signer, bool approved) external {
        if (msg.sender != owner) revert NotOwner();
        if (signer == address(0)) revert InvalidAddress();
        sessionSigner[signer] = approved;
        emit SessionSignerChanged(signer, approved);
    }

    function pause() external {
        if (msg.sender != owner) revert NotOwner();
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external {
        if (msg.sender != owner) revert NotOwner();
        paused = false;
        emit Unpaused(msg.sender);
    }

    function hashBatch(
        Call[] calldata calls,
        uint256 expectedNonce,
        uint256 deadline
    ) public view returns (bytes32) {
        bytes32[] memory callHashes = new bytes32[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            callHashes[i] = keccak256(
                abi.encode(
                    CALL_TYPEHASH,
                    calls[i].target,
                    calls[i].value,
                    keccak256(calls[i].data)
                )
            );
        }
        bytes32 structHash = keccak256(
            abi.encode(
                BATCH_TYPEHASH,
                address(this),
                expectedNonce,
                deadline,
                keccak256(abi.encodePacked(callHashes))
            )
        );
        return keccak256(
            abi.encodePacked("\x19\x01", _domainSeparator(), structHash)
        );
    }

    function onERC1155Received(
        address,
        address,
        uint256,
        uint256,
        bytes calldata
    ) external pure returns (bytes4) {
        return IERC1155ReceiverLike.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        return IERC1155ReceiverLike.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId)
        external
        pure
        returns (bool)
    {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0xd9b67a26
            || interfaceId == 0x1626ba7e;
    }

    function _domainNameAndVersion()
        internal
        pure
        override
        returns (string memory name, string memory version)
    {
        name = "DepositWallet";
        version = "1";
    }

    function _erc1271Signer() internal view override returns (address) {
        return owner;
    }

    function _erc1271IsValidSignatureNowCalldata(
        bytes32 hash,
        bytes calldata signature
    ) internal view override returns (bool) {
        if (paused) return false;
        address recovered = _recover(hash, signature);
        return recovered == owner || sessionSigner[recovered];
    }

    function _execute(Call[] calldata calls)
        internal
        returns (bytes[] memory results)
    {
        results = new bytes[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            (bool success, bytes memory result) =
                calls[i].target.call{value: calls[i].value}(calls[i].data);
            if (!success) revert CallFailed(i, result);
            results[i] = result;
        }
    }

    function _recover(bytes32 hash, bytes calldata signature)
        internal
        pure
        returns (address)
    {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        if (
            uint256(s)
                > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0
        ) return address(0);
        return ecrecover(hash, v, r, s);
    }
}

contract ResearchUpgradeableBeacon {
    address public implementation;
    address public immutable owner;

    event Upgraded(address indexed implementation);

    error InvalidImplementation();
    error NotOwner();

    constructor(address implementation_, address owner_) {
        owner = owner_;
        _upgradeTo(implementation_);
    }

    function upgradeTo(address implementation_) external {
        if (msg.sender != owner) revert NotOwner();
        _upgradeTo(implementation_);
    }

    function _upgradeTo(address implementation_) internal {
        if (implementation_.code.length == 0) revert InvalidImplementation();
        implementation = implementation_;
        emit Upgraded(implementation_);
    }
}

contract ResearchBeaconProxy {
    bytes32 private constant BEACON_SLOT =
        bytes32(uint256(keccak256("eip1967.proxy.beacon")) - 1);

    constructor(address beacon_, bytes memory initializationData) payable {
        bytes32 slot = BEACON_SLOT;
        assembly ("memory-safe") {
            sstore(slot, beacon_)
        }
        (bool success, bytes memory reason) =
            _implementation().delegatecall(initializationData);
        if (!success) {
            assembly ("memory-safe") {
                revert(add(reason, 32), mload(reason))
            }
        }
    }

    fallback() external payable {
        _delegate();
    }

    receive() external payable {
        _delegate();
    }

    function _implementation() internal view returns (address implementation_) {
        address beacon_;
        bytes32 slot = BEACON_SLOT;
        assembly ("memory-safe") {
            beacon_ := sload(slot)
        }
        implementation_ = ResearchUpgradeableBeacon(beacon_).implementation();
    }

    function _delegate() internal {
        address implementation_ = _implementation();
        assembly ("memory-safe") {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(
                gas(), implementation_, 0, calldatasize(), 0, 0
            )
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}

/// @notice One deterministic beacon-proxy wallet per owner, like the new flow.
contract ResearchDepositWalletFactory {
    ResearchUpgradeableBeacon public immutable BEACON;
    address public immutable admin;

    event WalletDeployed(address indexed wallet, address indexed owner);

    error InvalidAddress();
    error NotAdmin();

    constructor() {
        admin = msg.sender;
        ResearchDepositWallet implementation = new ResearchDepositWallet();
        BEACON = new ResearchUpgradeableBeacon(
            address(implementation), address(this)
        );
    }

    function createWallet(address owner) public returns (address wallet) {
        if (owner == address(0)) revert InvalidAddress();
        wallet = getWallet(owner);
        if (wallet.code.length == 0) {
            bytes32 salt = _salt(owner);
            wallet = address(
                new ResearchBeaconProxy{salt: salt}(
                    address(BEACON), _initializationData(owner)
                )
            );
            emit WalletDeployed(wallet, owner);
        }
    }

    function getWallet(address owner) public view returns (address) {
        bytes32 bytecodeHash = keccak256(
            abi.encodePacked(
                type(ResearchBeaconProxy).creationCode,
                abi.encode(address(BEACON), _initializationData(owner))
            )
        );
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xff),
                            address(this),
                            _salt(owner),
                            bytecodeHash
                        )
                    )
                )
            )
        );
    }

    function upgradeWalletImplementation(address implementation_) external {
        if (msg.sender != admin) revert NotAdmin();
        BEACON.upgradeTo(implementation_);
    }

    function _salt(address owner) internal pure returns (bytes32) {
        return keccak256(abi.encode(bytes32(uint256(uint160(owner)))));
    }

    function _initializationData(address owner)
        internal
        view
        returns (bytes memory)
    {
        return abi.encodeCall(
            ResearchDepositWallet.initialize, (owner, address(this))
        );
    }
}

/**
 * @notice Readable operator-driven CTF exchange modeled after CTF Exchange V2.
 * @dev Uses the public V2 Order fields and one-taker-to-many-makers entrypoint.
 *      It supports COMPLEMENTARY, MINT and MERGE settlement for binary markets.
 */
contract ResearchCLOBExchange is IERC1155ReceiverLike {
    enum Side {
        BUY,
        SELL
    }

    enum SignatureType {
        EOA,
        POLY_PROXY,
        POLY_GNOSIS_SAFE,
        POLY_1271
    }

    enum MatchType {
        COMPLEMENTARY,
        MINT,
        MERGE
    }

    struct Order {
        uint256 salt;
        address maker;
        address signer;
        uint256 tokenId;
        uint256 makerAmount;
        uint256 takerAmount;
        Side side;
        SignatureType signatureType;
        uint256 timestamp;
        bytes32 metadata;
        bytes32 builder;
        bytes signature;
    }

    struct OrderStatus {
        bool filled;
        uint248 remaining;
    }

    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)"
    );
    bytes32 public constant CANCEL_TYPEHASH =
        keccak256("Cancel(bytes32 orderHash)");
    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    ResearchERC20 public immutable collateral;
    ResearchOutcomeToken public immutable outcome;
    IResearchDepositWalletFactory public immutable walletFactory;
    address public admin;
    address public feeReceiver;
    uint256 public maxFeeRateBps = 500;
    uint256 public userPauseBlockInterval = 100;
    bool public tradingPaused;

    mapping(address => bool) public operators;
    mapping(address => uint256) public userPauseEffectiveBlock;
    mapping(bytes32 => OrderStatus) public orderStatus;
    mapping(bytes32 => bool) public preapproved;

    event FeeCharged(
        address indexed receiver,
        address indexed asset,
        uint256 indexed tokenId,
        uint256 amount
    );
    event OperatorChanged(address indexed operator, bool approved);
    event OrderCancelled(bytes32 indexed orderHash, address indexed maker);
    event OrderFilled(
        bytes32 indexed orderHash,
        address indexed maker,
        address indexed taker,
        Side side,
        uint256 tokenId,
        uint256 makerAmountFilled,
        uint256 takerAmountFilled,
        uint256 fee,
        bytes32 builder,
        bytes32 metadata
    );
    event OrdersMatched(
        bytes32 indexed takerOrderHash,
        address indexed takerOrderMaker,
        Side side,
        uint256 tokenId,
        uint256 makerAmountFilled,
        uint256 takerAmountFilled
    );
    event OrderPreapproved(bytes32 indexed orderHash);
    event OrderPreapprovalInvalidated(bytes32 indexed orderHash);
    event TradingPaused(address indexed account);
    event TradingUnpaused(address indexed account);
    event UserPauseRequested(address indexed user, uint256 effectiveBlock);
    event UserUnpaused(address indexed user);

    error FeeExceedsProceeds();
    error FeeTooHigh();
    error InvalidAddress();
    error InvalidSignature();
    error MakingGtRemaining();
    error MismatchedArrayLengths();
    error MismatchedTokenIds();
    error NoMakerOrders();
    error NotAdmin();
    error NotCrossing();
    error NotOperator();
    error OrderAlreadyFilled();
    error OrderNotOwned();
    error TradingIsPaused();
    error UnsupportedMatch();
    error UserIsPaused();
    error ZeroMakerAmount();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyOperator() {
        if (!operators[msg.sender]) revert NotOperator();
        _;
    }

    modifier notPaused() {
        if (tradingPaused) revert TradingIsPaused();
        _;
    }

    constructor(
        address collateral_,
        address outcome_,
        address walletFactory_,
        address admin_,
        address operator_,
        address feeReceiver_
    ) {
        if (
            collateral_ == address(0) || outcome_ == address(0)
                || walletFactory_ == address(0) || admin_ == address(0)
                || operator_ == address(0) || feeReceiver_ == address(0)
        ) revert InvalidAddress();
        collateral = ResearchERC20(collateral_);
        outcome = ResearchOutcomeToken(outcome_);
        walletFactory = IResearchDepositWalletFactory(walletFactory_);
        admin = admin_;
        feeReceiver = feeReceiver_;
        operators[operator_] = true;
        emit OperatorChanged(operator_, true);
    }

    function setOperator(address operator, bool approved) external onlyAdmin {
        if (operator == address(0)) revert InvalidAddress();
        operators[operator] = approved;
        emit OperatorChanged(operator, approved);
    }

    function setFeeReceiver(address receiver) external onlyAdmin {
        if (receiver == address(0)) revert InvalidAddress();
        feeReceiver = receiver;
    }

    function setMaxFeeRate(uint256 rate) external onlyAdmin {
        if (rate > 10_000) revert FeeTooHigh();
        maxFeeRateBps = rate;
    }

    function pauseTrading() external onlyAdmin {
        tradingPaused = true;
        emit TradingPaused(msg.sender);
    }

    function unpauseTrading() external onlyAdmin {
        tradingPaused = false;
        emit TradingUnpaused(msg.sender);
    }

    function requestUserPause() external {
        uint256 effectiveBlock = block.number + userPauseBlockInterval;
        userPauseEffectiveBlock[msg.sender] = effectiveBlock;
        emit UserPauseRequested(msg.sender, effectiveBlock);
    }

    function unpauseUser(address user) external onlyAdmin {
        userPauseEffectiveBlock[user] = 0;
        emit UserUnpaused(user);
    }

    function isUserPaused(address user) public view returns (bool) {
        uint256 effectiveBlock = userPauseEffectiveBlock[user];
        return effectiveBlock != 0 && block.number >= effectiveBlock;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("Polymarket CTF Exchange")),
                keccak256(bytes("2")),
                block.chainid,
                address(this)
            )
        );
    }

    /// @notice Returns the EIP-712 digest, matching the V2 public API meaning.
    function hashOrder(Order memory order) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                ORDER_TYPEHASH,
                order.salt,
                order.maker,
                order.signer,
                order.tokenId,
                order.makerAmount,
                order.takerAmount,
                order.side,
                order.signatureType,
                order.timestamp,
                order.metadata,
                order.builder
            )
        );
        return keccak256(
            abi.encodePacked("\x19\x01", domainSeparator(), structHash)
        );
    }

    function getOrderStatus(bytes32 orderHash)
        external
        view
        returns (OrderStatus memory)
    {
        return orderStatus[orderHash];
    }

    function remainingMakerAmount(Order memory order)
        public
        view
        returns (uint256)
    {
        OrderStatus memory status = orderStatus[hashOrder(order)];
        if (status.filled) return 0;
        return status.remaining == 0 ? order.makerAmount : status.remaining;
    }

    function validateOrder(Order memory order) external view {
        _validateOrder(hashOrder(order), order);
    }

    function preapproveOrder(Order memory order) external onlyOperator {
        bytes32 orderHash = hashOrder(order);
        _validateSignature(orderHash, order);
        preapproved[orderHash] = true;
        emit OrderPreapproved(orderHash);
    }

    function invalidatePreapprovedOrder(bytes32 orderHash)
        external
        onlyOperator
    {
        preapproved[orderHash] = false;
        emit OrderPreapprovalInvalidated(orderHash);
    }

    /**
     * @notice Research extension: lets the maker invalidate a signed order.
     * @dev Official V2 does not expose the legacy maker cancelOrder entrypoint.
     */
    function cancelOrder(Order calldata order, bytes calldata cancelSignature)
        external
    {
        bytes32 orderHash = hashOrder(order);
        if (orderStatus[orderHash].filled) revert OrderAlreadyFilled();
        bytes32 cancelStructHash =
            keccak256(abi.encode(CANCEL_TYPEHASH, orderHash));
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", domainSeparator(), cancelStructHash)
        );
        if (!_isOrderSigner(order, digest, cancelSignature)) {
            revert InvalidSignature();
        }
        orderStatus[orderHash] =
            OrderStatus({filled: true, remaining: 0});
        emit OrderCancelled(orderHash, order.maker);
    }

    function matchOrders(
        bytes32 conditionId,
        Order calldata takerOrder,
        Order[] calldata makerOrders,
        uint256 takerFillAmount,
        uint256[] calldata makerFillAmounts,
        uint256 takerFeeAmount,
        uint256[] calldata makerFeeAmounts
    ) external onlyOperator notPaused {
        uint256 makerLength = makerOrders.length;
        if (makerLength == 0) revert NoMakerOrders();
        if (
            makerLength != makerFillAmounts.length
                || makerLength != makerFeeAmounts.length
        ) revert MismatchedArrayLengths();

        _validateConditionTokens(conditionId, takerOrder, makerOrders);
        MatchType matchType = _matchType(takerOrder, makerOrders);
        if (matchType == MatchType.COMPLEMENTARY) {
            _settleComplementary(
                takerOrder,
                makerOrders,
                takerFillAmount,
                makerFillAmounts,
                takerFeeAmount,
                makerFeeAmounts
            );
        } else if (matchType == MatchType.MINT) {
            _settleMint(
                conditionId,
                takerOrder,
                makerOrders,
                takerFillAmount,
                makerFillAmounts,
                takerFeeAmount,
                makerFeeAmounts
            );
        } else {
            _settleMerge(
                conditionId,
                takerOrder,
                makerOrders,
                takerFillAmount,
                makerFillAmounts,
                takerFeeAmount,
                makerFeeAmounts
            );
        }
    }

    function _settleComplementary(
        Order calldata taker,
        Order[] calldata makers,
        uint256 takerFill,
        uint256[] calldata makerFills,
        uint256 takerFee,
        uint256[] calldata makerFees
    ) internal {
        bytes32 takerHash = hashOrder(taker);
        _validateOrder(takerHash, taker);
        uint256 totalTakerMaking;
        uint256 totalTakerTaking;

        for (uint256 i; i < makers.length; ++i) {
            Order calldata maker = makers[i];
            bytes32 makerHash = hashOrder(maker);
            _validateOrder(makerHash, maker);
            uint256 makerTaking = _takingAmount(maker, makerFills[i]);
            _validateFee(makerTaking, makerFees[i]);

            if (taker.side == Side.BUY) {
                totalTakerMaking += makerTaking;
                totalTakerTaking += makerFills[i];
                outcome.safeTransferFrom(
                    maker.maker,
                    address(this),
                    maker.tokenId,
                    makerFills[i],
                    ""
                );
                uint256 makerProceeds = makerTaking - makerFees[i];
                if (makerProceeds > 0) {
                    _safeCollateralTransferFrom(
                        taker.maker, maker.maker, makerProceeds
                    );
                }
                if (makerFees[i] > 0) {
                    _safeCollateralTransferFrom(
                        taker.maker, feeReceiver, makerFees[i]
                    );
                    emit FeeCharged(
                        feeReceiver,
                        address(collateral),
                        0,
                        makerFees[i]
                    );
                }
            } else {
                totalTakerMaking += makerTaking;
                totalTakerTaking += makerFills[i];
                _safeCollateralTransferFrom(
                    maker.maker, address(this), makerFills[i]
                );
                outcome.safeTransferFrom(
                    taker.maker,
                    address(this),
                    taker.tokenId,
                    makerTaking,
                    ""
                );
                uint256 makerProceeds = makerTaking - makerFees[i];
                if (makerProceeds > 0) {
                    outcome.safeTransferFrom(
                        address(this),
                        maker.maker,
                        maker.tokenId,
                        makerProceeds,
                        ""
                    );
                }
                if (makerFees[i] > 0) {
                    outcome.safeTransferFrom(
                        address(this),
                        feeReceiver,
                        maker.tokenId,
                        makerFees[i],
                        ""
                    );
                    emit FeeCharged(
                        feeReceiver,
                        address(outcome),
                        maker.tokenId,
                        makerFees[i]
                    );
                }
            }

            _consume(makerHash, maker.makerAmount, makerFills[i]);
            emit OrderFilled(
                makerHash,
                maker.maker,
                taker.maker,
                maker.side,
                maker.tokenId,
                makerFills[i],
                makerTaking,
                makerFees[i],
                maker.builder,
                maker.metadata
            );
        }

        if (totalTakerMaking > takerFill) revert NotCrossing();
        uint256 minimumTaking = _takingAmount(taker, totalTakerMaking);
        if (totalTakerTaking < minimumTaking) revert NotCrossing();
        _validateFee(totalTakerTaking, takerFee);

        if (taker.side == Side.BUY) {
            uint256 proceeds = totalTakerTaking - takerFee;
            outcome.safeTransferFrom(
                address(this), taker.maker, taker.tokenId, proceeds, ""
            );
            if (takerFee > 0) {
                outcome.safeTransferFrom(
                    address(this),
                    feeReceiver,
                    taker.tokenId,
                    takerFee,
                    ""
                );
                emit FeeCharged(
                    feeReceiver,
                    address(outcome),
                    taker.tokenId,
                    takerFee
                );
            }
        } else {
            uint256 proceeds = totalTakerTaking - takerFee;
            if (proceeds > 0) _safeCollateralTransfer(taker.maker, proceeds);
            if (takerFee > 0) {
                _safeCollateralTransfer(feeReceiver, takerFee);
                emit FeeCharged(
                    feeReceiver, address(collateral), 0, takerFee
                );
            }
        }

        _consume(takerHash, taker.makerAmount, totalTakerMaking);
        emit OrderFilled(
            takerHash,
            taker.maker,
            address(this),
            taker.side,
            taker.tokenId,
            totalTakerMaking,
            totalTakerTaking,
            takerFee,
            taker.builder,
            taker.metadata
        );
        emit OrdersMatched(
            takerHash,
            taker.maker,
            taker.side,
            taker.tokenId,
            totalTakerMaking,
            totalTakerTaking
        );
    }

    function _settleMint(
        bytes32 conditionId,
        Order calldata taker,
        Order[] calldata makers,
        uint256 takerFill,
        uint256[] calldata makerFills,
        uint256 takerFee,
        uint256[] calldata makerFees
    ) internal {
        if (taker.side != Side.BUY) revert UnsupportedMatch();
        bytes32 takerHash = hashOrder(taker);
        _validateOrder(takerHash, taker);
        uint256 takerShares = _takingAmount(taker, takerFill);
        uint256 makerShares;
        uint256 totalCollateral = takerFill;

        for (uint256 i; i < makers.length; ++i) {
            bytes32 makerHash = hashOrder(makers[i]);
            _validateOrder(makerHash, makers[i]);
            uint256 taking = _takingAmount(makers[i], makerFills[i]);
            makerShares += taking;
            totalCollateral += makerFills[i];
            _validateFee(taking, makerFees[i]);
        }
        if (makerShares != takerShares || totalCollateral != takerShares) {
            revert NotCrossing();
        }
        _validateFee(takerShares, takerFee);

        _safeCollateralTransferFrom(
            taker.maker, address(outcome), takerFill
        );
        for (uint256 i; i < makers.length; ++i) {
            _safeCollateralTransferFrom(
                makers[i].maker, address(outcome), makerFills[i]
            );
        }
        outcome.exchangeMintCompleteSet(
            conditionId, address(this), takerShares
        );

        outcome.safeTransferFrom(
            address(this),
            taker.maker,
            taker.tokenId,
            takerShares - takerFee,
            ""
        );
        if (takerFee > 0) {
            outcome.safeTransferFrom(
                address(this),
                feeReceiver,
                taker.tokenId,
                takerFee,
                ""
            );
        }
        _consume(takerHash, taker.makerAmount, takerFill);
        emit OrderFilled(
            takerHash,
            taker.maker,
            address(this),
            taker.side,
            taker.tokenId,
            takerFill,
            takerShares,
            takerFee,
            taker.builder,
            taker.metadata
        );

        for (uint256 i; i < makers.length; ++i) {
            Order calldata maker = makers[i];
            bytes32 makerHash = hashOrder(maker);
            uint256 shares = _takingAmount(maker, makerFills[i]);
            outcome.safeTransferFrom(
                address(this),
                maker.maker,
                maker.tokenId,
                shares - makerFees[i],
                ""
            );
            if (makerFees[i] > 0) {
                outcome.safeTransferFrom(
                    address(this),
                    feeReceiver,
                    maker.tokenId,
                    makerFees[i],
                    ""
                );
            }
            _consume(makerHash, maker.makerAmount, makerFills[i]);
            emit OrderFilled(
                makerHash,
                maker.maker,
                taker.maker,
                maker.side,
                maker.tokenId,
                makerFills[i],
                shares,
                makerFees[i],
                maker.builder,
                maker.metadata
            );
        }
        emit OrdersMatched(
            takerHash,
            taker.maker,
            taker.side,
            taker.tokenId,
            takerFill,
            takerShares
        );
    }

    function _settleMerge(
        bytes32 conditionId,
        Order calldata taker,
        Order[] calldata makers,
        uint256 takerFill,
        uint256[] calldata makerFills,
        uint256 takerFee,
        uint256[] calldata makerFees
    ) internal {
        if (taker.side != Side.SELL) revert UnsupportedMatch();
        bytes32 takerHash = hashOrder(taker);
        _validateOrder(takerHash, taker);
        uint256 makerShares;
        uint256 totalProceeds = _takingAmount(taker, takerFill);
        _validateFee(totalProceeds, takerFee);

        outcome.safeTransferFrom(
            taker.maker, address(this), taker.tokenId, takerFill, ""
        );
        for (uint256 i; i < makers.length; ++i) {
            Order calldata maker = makers[i];
            bytes32 makerHash = hashOrder(maker);
            _validateOrder(makerHash, maker);
            makerShares += makerFills[i];
            uint256 proceeds = _takingAmount(maker, makerFills[i]);
            totalProceeds += proceeds;
            _validateFee(proceeds, makerFees[i]);
            outcome.safeTransferFrom(
                maker.maker,
                address(this),
                maker.tokenId,
                makerFills[i],
                ""
            );
        }
        if (makerShares != takerFill || totalProceeds > takerFill) {
            revert NotCrossing();
        }
        outcome.exchangeMergeCompleteSet(
            conditionId, address(this), address(this), takerFill
        );

        uint256 takerProceeds = _takingAmount(taker, takerFill);
        _safeCollateralTransfer(taker.maker, takerProceeds - takerFee);
        if (takerFee > 0) {
            _safeCollateralTransfer(feeReceiver, takerFee);
        }
        _consume(takerHash, taker.makerAmount, takerFill);
        emit OrderFilled(
            takerHash,
            taker.maker,
            address(this),
            taker.side,
            taker.tokenId,
            takerFill,
            takerProceeds,
            takerFee,
            taker.builder,
            taker.metadata
        );

        for (uint256 i; i < makers.length; ++i) {
            Order calldata maker = makers[i];
            bytes32 makerHash = hashOrder(maker);
            uint256 proceeds = _takingAmount(maker, makerFills[i]);
            _safeCollateralTransfer(
                maker.maker, proceeds - makerFees[i]
            );
            if (makerFees[i] > 0) {
                _safeCollateralTransfer(feeReceiver, makerFees[i]);
            }
            _consume(makerHash, maker.makerAmount, makerFills[i]);
            emit OrderFilled(
                makerHash,
                maker.maker,
                taker.maker,
                maker.side,
                maker.tokenId,
                makerFills[i],
                proceeds,
                makerFees[i],
                maker.builder,
                maker.metadata
            );
        }
        uint256 surplus = takerFill - totalProceeds;
        if (surplus > 0) _safeCollateralTransfer(feeReceiver, surplus);
        emit OrdersMatched(
            takerHash,
            taker.maker,
            taker.side,
            taker.tokenId,
            takerFill,
            takerProceeds
        );
    }

    function _matchType(
        Order calldata taker,
        Order[] calldata makers
    ) internal pure returns (MatchType matchType) {
        bool sameSide = makers[0].side == taker.side;
        for (uint256 i; i < makers.length; ++i) {
            if ((makers[i].side == taker.side) != sameSide) {
                revert UnsupportedMatch();
            }
            if (sameSide) {
                if (makers[i].tokenId == taker.tokenId) {
                    revert MismatchedTokenIds();
                }
            } else if (makers[i].tokenId != taker.tokenId) {
                revert MismatchedTokenIds();
            }
        }
        if (!sameSide) return MatchType.COMPLEMENTARY;
        return taker.side == Side.BUY ? MatchType.MINT : MatchType.MERGE;
    }

    function _validateConditionTokens(
        bytes32 conditionId,
        Order calldata taker,
        Order[] calldata makers
    ) internal view {
        uint256 yes = outcome.yesTokenId(conditionId);
        uint256 no = outcome.noTokenId(conditionId);
        if (
            yes == 0 || (taker.tokenId != yes && taker.tokenId != no)
        ) revert MismatchedTokenIds();
        for (uint256 i; i < makers.length; ++i) {
            if (makers[i].tokenId != yes && makers[i].tokenId != no) {
                revert MismatchedTokenIds();
            }
        }
    }

    function _validateOrder(bytes32 orderHash, Order memory order)
        internal
        view
    {
        if (order.makerAmount == 0) revert ZeroMakerAmount();
        if (orderStatus[orderHash].filled) revert OrderAlreadyFilled();
        if (isUserPaused(order.maker)) revert UserIsPaused();
        if (order.signature.length == 0) {
            if (!preapproved[orderHash]) revert InvalidSignature();
        } else {
            _validateSignature(orderHash, order);
        }
    }

    function _validateSignature(bytes32 orderHash, Order memory order)
        internal
        view
    {
        if (!_isOrderSigner(order, orderHash, order.signature)) {
            revert InvalidSignature();
        }
    }

    function _isOrderSigner(
        Order memory order,
        bytes32 digest,
        bytes memory signature
    ) internal view returns (bool) {
        if (order.signatureType == SignatureType.EOA) {
            return order.signer == order.maker
                && _recover(digest, signature) == order.signer;
        }
        if (order.signatureType == SignatureType.POLY_PROXY) {
            return _recover(digest, signature) == order.signer
                && walletFactory.getWallet(order.signer) == order.maker;
        }
        if (order.signatureType == SignatureType.POLY_1271) {
            if (
                order.signer != order.maker || order.maker.code.length == 0
            ) return false;
            try IERC1271Like(order.maker).isValidSignature(
                digest, signature
            ) returns (bytes4 magic) {
                return magic == 0x1626ba7e;
            } catch {
                return false;
            }
        }
        // Safe derivation is intentionally not reproduced in this research build.
        return false;
    }

    function _consume(
        bytes32 orderHash,
        uint256 makerAmount,
        uint256 making
    ) internal {
        OrderStatus storage status = orderStatus[orderHash];
        uint256 remaining =
            status.remaining == 0 ? makerAmount : status.remaining;
        if (making == 0 || making > remaining) revert MakingGtRemaining();
        remaining -= making;
        status.remaining = uint248(remaining);
        status.filled = remaining == 0;
    }

    function _takingAmount(Order calldata order, uint256 making)
        internal
        pure
        returns (uint256)
    {
        if (making == 0 || making > order.makerAmount) {
            revert MakingGtRemaining();
        }
        uint256 numerator = making * order.takerAmount;
        return (numerator + order.makerAmount - 1) / order.makerAmount;
    }

    function _validateFee(uint256 proceeds, uint256 fee) internal view {
        if (fee > proceeds) revert FeeExceedsProceeds();
        if (fee * 10_000 > proceeds * maxFeeRateBps) revert FeeTooHigh();
    }

    function _safeCollateralTransferFrom(
        address from,
        address to,
        uint256 amount
    ) internal {
        if (!collateral.transferFrom(from, to, amount)) {
            revert InvalidAddress();
        }
    }

    function _safeCollateralTransfer(address to, uint256 amount) internal {
        if (!collateral.transfer(to, amount)) revert InvalidAddress();
    }

    function _recover(bytes32 hash, bytes memory signature)
        internal
        pure
        returns (address)
    {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        if (
            uint256(s)
                > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0
        ) return address(0);
        return ecrecover(hash, v, r, s);
    }

    function onERC1155Received(
        address,
        address,
        uint256,
        uint256,
        bytes calldata
    ) external pure returns (bytes4) {
        return IERC1155ReceiverLike.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        return IERC1155ReceiverLike.onERC1155BatchReceived.selector;
    }
}
